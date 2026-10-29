import { fail, type Contract } from "../../../contract/src/index.js";
import type { BudgetState } from "../../../contract/src/index.js";
import type { Clock } from "../dependencies.js";
import type { Repository } from "../storage/repository.js";
import type { BudgetReservation, BudgetScope, CallLog, ModelRequest, ProviderModel } from "./types.js";

export class BudgetLedger {
  constructor(
    private readonly store: Repository,
    private readonly clock: Clock,
    private readonly contract: Contract,
    private readonly timeZone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    private readonly defaultTurnLimit: () => number | undefined = () => undefined,
  ) {}
  private normalize(scope: BudgetScope): BudgetScope {
    if (scope.kind === "daily" && !scope.key) {
      let key: string;
      try {
        const parts = new Intl.DateTimeFormat("en", {
          timeZone: this.timeZone(),
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date(this.clock.now()));
        const get = (type: string) =>
          parts.find((part) => part.type === type)?.value ?? fail("internal", "Could not determine local budget date");
        key = `${get("year")}-${get("month")}-${get("day")}`;
      } catch {
        fail("invalid", "Invalid daily budget time zone");
      }
      return { kind: scope.kind, key };
    }
    if (!scope.key) fail("invalid", "Budget account key is required");
    return scope;
  }
  private key(scope: BudgetScope): string {
    const normalized = this.normalize(scope);
    return `${normalized.kind}:${normalized.key}`;
  }
  private readState(scope: BudgetScope): BudgetState {
    const normalized = this.normalize(scope),
      found = this.store.feedback("budget-account", this.key(normalized));
    return this.contract.read<BudgetState>(
      "budget-state",
      found ?? {
        account: normalized,
        limitMicros: normalized.kind === "turn" ? (this.defaultTurnLimit() ?? null) : null,
        usedMicros: 0,
        reservedMicros: 0,
      },
    );
  }
  state(scope: BudgetScope): BudgetState {
    return this.readState(scope);
  }
  states(): BudgetState[] {
    return this.store.feedbackList("budget-account").map((row) => this.contract.read<BudgetState>("budget-state", row));
  }
  setLimit(scope: BudgetScope, limitMicros: number | null): BudgetState {
    if (limitMicros !== null && (!Number.isSafeInteger(limitMicros) || limitMicros < 0))
      fail("invalid", "Budget limit must be a non-negative integer");
    return this.store.transaction(() => {
      const current = this.readState(scope),
        next = this.contract.read<BudgetState>("budget-state", {
          ...current,
          limitMicros,
        });
      if (limitMicros !== null && current.usedMicros + current.reservedMicros > limitMicros)
        fail("conflict", "New budget limit is below existing usage");
      this.store.saveFeedback("budget-account", this.key(next.account), this.contract.read("json", next));
      return next;
    });
  }
  reserve(reservationId: string, scopes: BudgetScope[], amountMicros: number): BudgetReservation {
    if (!reservationId || !Number.isSafeInteger(amountMicros) || amountMicros < 0)
      fail("invalid", "Invalid budget reservation");
    return this.store.transaction(() => {
      const existing = this.reservationOrUndefined(reservationId);
      if (existing) {
        if (existing.amountMicros !== amountMicros || existing.state !== "reserved")
          fail("conflict", "Reservation id is already in use");
        return existing;
      }
      const unique = new Map(scopes.map((scope) => [this.key(scope), this.normalize(scope)]));
      const normalizedScopes = [...unique.values()];
      if (!normalizedScopes.length) fail("invalid", "At least one budget account is required");
      const states = normalizedScopes.map((scope) => this.readState(scope));
      for (const state of states)
        if (state.limitMicros !== null && state.usedMicros + state.reservedMicros + amountMicros > state.limitMicros)
          fail("budget_exceeded", "Model call exceeds a budget limit");
      const reservation: BudgetReservation = this.contract.read<BudgetReservation>("budget-reservation", {
        reservationId,
        amountMicros,
        scopes: normalizedScopes.map((account) => ({
          account,
          amountMicros,
        })),
        state: "reserved",
      });
      for (const state of states)
        this.store.saveFeedback(
          "budget-account",
          this.key(state.account),
          this.contract.read("json", {
            ...state,
            reservedMicros: state.reservedMicros + amountMicros,
          }),
        );
      this.store.saveFeedback("budget-reservation", reservationId, this.contract.read("json", reservation));
      return reservation;
    });
  }
  reservation(id: string): BudgetReservation {
    const result = this.reservationOrUndefined(id);
    if (!result) fail("not_found", "Budget reservation not found");
    return result;
  }
  private reservationOrUndefined(id: string): BudgetReservation | undefined {
    const value = this.store.feedback("budget-reservation", id);
    return value === undefined ? undefined : this.contract.read<BudgetReservation>("budget-reservation", value);
  }
  assertReserved(id: string): BudgetReservation {
    const reservation = this.reservationOrUndefined(id);
    if (!reservation) fail("budget_exceeded", "A budget reservation is required before a model call");
    if (reservation.state !== "reserved")
      fail("budget_exceeded", "A live budget reservation is required before a model call");
    return reservation;
  }
  markUncertain(id: string): BudgetReservation {
    return this.store.transaction(() => {
      const current = this.reservation(id);
      if (current.state === "settled") return current;
      const next = this.contract.read<BudgetReservation>("budget-reservation", {
        ...current,
        state: "uncertain",
        usageQuality: "unknown",
        settledMicros: current.amountMicros,
      });
      this.store.saveFeedback("budget-reservation", id, this.contract.read("json", next));
      return next;
    });
  }
  markTurnUncertain(turnId: string): void {
    const pending = this.store
      .feedbackList("budget-reservation")
      .map((row) => this.contract.read<BudgetReservation>("budget-reservation", row))
      .filter(
        (reservation) =>
          reservation.state === "reserved" &&
          reservation.scopes.some(({ account }) => account.kind === "turn" && account.key === turnId),
      );
    for (const reservation of pending) this.markUncertain(reservation.reservationId);
  }
  settle(id: string, settledMicros: number, quality: "reported" | "estimated" | "unknown"): BudgetReservation {
    if (quality === "unknown") return this.markUncertain(id);
    if (!Number.isSafeInteger(settledMicros) || settledMicros < 0) fail("invalid", "Invalid settled usage");
    return this.store.transaction(() => {
      const current = this.reservation(id);
      if (current.state === "settled") {
        if (current.settledMicros === settledMicros && current.usageQuality === quality) return current;
        fail("conflict", "Budget reservation has already been settled");
      }
      if (current.state === "uncertain") fail("conflict", "Uncertain reservations cannot be settled automatically");
      if (settledMicros > current.amountMicros) fail("budget_exceeded", "Reported usage exceeded its reservation");
      for (const entry of current.scopes) {
        const state = this.readState(entry.account);
        this.store.saveFeedback(
          "budget-account",
          this.key(state.account),
          this.contract.read("json", {
            ...state,
            reservedMicros: Math.max(0, state.reservedMicros - entry.amountMicros),
            usedMicros: state.usedMicros + settledMicros,
          }),
        );
      }
      const next = this.contract.read<BudgetReservation>("budget-reservation", {
        ...current,
        state: "settled",
        usageQuality: quality,
        settledMicros,
      });
      this.store.saveFeedback("budget-reservation", id, this.contract.read("json", next));
      return next;
    });
  }
  log(value: CallLog): void {
    const checked = this.contract.read<CallLog>("call-log", value);
    this.store.transaction(() => this.store.saveCallLog(checked));
  }
  calls(): CallLog[] {
    return this.store.callLogs().map((value) => this.contract.read<CallLog>("call-log", value));
  }
}

export function estimateInputTokens(request: ModelRequest): number {
  return Math.ceil(
    JSON.stringify({
      messages: request.messages,
      tools: request.tools ?? [],
      output: request.output ?? null,
    }).length / 3,
  );
}
export function estimateReservationMicros(request: ModelRequest, model: ProviderModel): number {
  const input = estimateInputTokens(request),
    output = request.maxOutputTokens;
  const amount =
    Math.ceil((input * model.pricing.inputMicrosPerMillion) / 1_000_000) +
    Math.ceil((output * model.pricing.outputMicrosPerMillion) / 1_000_000);
  if (!Number.isSafeInteger(amount)) fail("invalid", "Estimated model cost is outside the supported range");
  return amount;
}
export function reportedCostMicros(inputTokens: number, outputTokens: number, model: ProviderModel): number {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0)
    fail("invalid", "Invalid model usage");
  const cost =
    Math.ceil((inputTokens * model.pricing.inputMicrosPerMillion) / 1_000_000) +
    Math.ceil((outputTokens * model.pricing.outputMicrosPerMillion) / 1_000_000);
  if (!Number.isSafeInteger(cost)) fail("invalid", "Reported model cost is outside the supported range");
  return cost;
}
