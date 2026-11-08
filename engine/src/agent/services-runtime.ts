import { Content } from "../content/index.js";
import { errorOf } from "../../../contract/src/index.js";
import { Feedback } from "../feedback/index.js";
import { BudgetLedger } from "../gateway/ledger.js";
import { ProviderGateway } from "../gateway/gateway.js";
import { OpenAICompatibleProvider } from "../gateway/providers/openai-compatible.js";
import type { BudgetPort, GatewayPort } from "../kernel/module-registry.js";
import { QueryOperations } from "../runtime/query-operations.js";

export abstract class AgentServicesRuntime extends QueryOperations {
  protected initializeServices(): void {
    const store = this.available();
    this.content = new Content(store, this.contract, this.deps.clock, this.deps.ids);
    this.feedback = new Feedback(store, this.contract, this.deps.clock, this.deps.ids, () => this.settings());
    this.budgets = new BudgetLedger(
      store,
      this.deps.clock,
      this.contract,
      () => this.settings().budgets.localTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      () => this.settings().budgets.defaultTurnLimitMicros,
    );
    this.gateway = new ProviderGateway(
      this.settings().models,
      {
        "openai-compatible": new OpenAICompatibleProvider(this.deps.keyStore),
        ...this.deps.modelProviders,
      },
      this.budgets,
      this.contract,
      this.deps.clock,
    );
  }

  protected closeServices(): void {
    this.content = undefined;
    this.feedback = undefined;
    this.budgets = undefined;
    this.gateway = undefined;
  }

  protected settingsChanged(): void {
    this.gateway?.setModels(this.settings().models);
  }

  protected gatewayPort(): GatewayPort | undefined {
    return this.gateway ? { call: (request, options) => this.gateway!.call(request, options) } : undefined;
  }

  protected budgetsPort(): BudgetPort | undefined {
    return this.budgets
      ? {
          markTurnUncertain: (turnId) => this.budgets!.markTurnUncertain(turnId),
          markUncertain: (reservationId) => this.budgets!.markUncertain(reservationId),
          setRunLimit: (runId, limitMicros) => this.budgets!.setLimit({ kind: "run", key: runId }, limitMicros),
          reserve: (reservationId, runId, amountMicros) =>
            this.budgets!.reserve(reservationId, [{ kind: "run", key: runId }, { kind: "daily" }], amountMicros),
        }
      : undefined;
  }

  protected markReservationUncertain(reservationId: string): void {
    try {
      this.budgets?.markUncertain(reservationId);
    } catch (error) {
      if (errorOf(error).code !== "not_found") throw error;
    }
  }
}
