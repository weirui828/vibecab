import { open, mkdir, readFile, unlink, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Contract, errorOf, fail } from "../../../contract/src/index.js";
import type {
  CallContext,
  CommandEnvelope,
  CommandResult,
  Json,
  Settings,
  QueryEnvelope,
  FeedbackComment,
  Agreement,
  Update,
  Job,
} from "../../../contract/src/index.js";
import { SqliteStore } from "../storage/sqlite.js";

import type { Dependencies } from "../dependencies.js";
import { Authentication, randomAccessTokenKey } from "./authentication.js";
import type { CallAuth, CallMetadata, TrustedHostCredential } from "../auth.js";
import { SerialQueue } from "./queue.js";
import { JobRunner } from "./jobs.js";
import { ModuleRegistry } from "./module-registry.js";
import type { BudgetPort, EngineModule, GatewayPort, GatewayRequestPort, ModuleContext } from "./module-registry.js";

export abstract class EngineCore {
  protected readonly contract = new Contract();

  protected readonly queue = new SerialQueue();

  protected store: SqliteStore | undefined;

  protected jobs: JobRunner | undefined;

  protected lock: FileHandle | undefined;

  protected workspace = "";

  protected accepting = false;

  protected starting = false;

  protected readonly listeners = new Set<() => void>();

  protected workerTimer: ReturnType<typeof setInterval> | undefined;

  protected readonly sessionTails = new Map<string, Promise<void>>();

  private registry: ModuleRegistry | undefined;

  private lifecycleContext: ModuleContext | undefined;

  protected readonly authentication: Authentication;

  constructor(protected readonly deps: Dependencies) {
    this.authentication = new Authentication(deps.clock, deps.ids, <T>(value: unknown) =>
      this.contract.read<T>("call-metadata", value),
    );
  }

  protected mintTrustedHost(scope: TrustedHostCredential["scope"]): TrustedHostCredential {
    return this.authentication.mintTrustedHost(scope);
  }

  protected configureModules(modules: readonly EngineModule[]): void {
    this.registry = new ModuleRegistry(
      modules,
      [...this.contract.operations].map(([name, operation]) => ({ name, kind: operation.kind })),
    );
  }

  protected dispatchLegacyCommand(ctx: CallContext, cmd: CommandEnvelope): unknown {
    return this.dispatchOperationCommand(ctx, cmd);
  }

  protected dispatchLegacyQuery(ctx: CallContext, query: QueryEnvelope): unknown {
    return this.dispatchOperationQuery(ctx, query);
  }

  private dispatchCommand(ctx: CallContext, command: CommandEnvelope): unknown {
    const registered = this.registry?.commands.get(command.type);
    if (!registered) fail("unsupported", "Command has no registered module handler");
    return registered.handler(this.moduleContext(), ctx, command);
  }

  private dispatchQuery(ctx: CallContext, query: QueryEnvelope): unknown {
    const registered = this.registry?.queries.get(query.name);
    if (!registered) fail("unsupported", "Query has no registered module handler");
    return registered.handler(this.moduleContext(), ctx, query);
  }

  protected moduleContext(): ModuleContext {
    if (this.lifecycleContext) return this.lifecycleContext;
    const store = this.available();
    this.lifecycleContext = {
      repository: store,
      mutate: (action) => this.queue.run(() => store.transaction(action)),
      clock: this.deps.clock,
      ids: this.deps.ids,
      contract: {
        read: <T>(name: string, value: unknown, path?: string) => this.contract.read<T>(name, value, path),
        schemaIsValid: (schema) => this.contract.schemaIsValid(schema),
      },
      appendEvent: (event) => store.appendEvent(event),
      enqueue: (kind, id, payload, ts) => store.enqueue(kind, id, payload, ts),
      settings: () => this.contract.read<Json>("json", this.settings()),
      ...(this.gatewayPort() ? { gateway: this.gatewayPort() } : {}),
      ...(this.budgetsPort() ? { budgets: this.budgetsPort() } : {}),
    };
    return this.lifecycleContext;
  }

  protected wake() {
    for (const fn of [...this.listeners]) fn();
  }

  protected async serializeSession<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionTails.set(sessionId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    }
  }

  protected available(): SqliteStore {
    if (!this.store) fail("unavailable", "Engine is stopped");
    return this.store;
  }

  protected context(auth: CallAuth, rawMetadata: CallMetadata): CallContext {
    return this.authentication.resolve(auth, rawMetadata, this.available());
  }

  protected authorize(
    ctx: CallContext,
    effect: "read" | "collaborate" | "admin",
    channels: CallContext["channel"][] = ["in_process", "http", "cli", "mcp"],
  ) {
    if (
      !channels.includes(ctx.channel) ||
      ["read", "collaborate", "admin"].indexOf(ctx.scope) < ["read", "collaborate", "admin"].indexOf(effect)
    )
      fail("forbidden", "Operation is not permitted");
  }

  protected operation(ctx: CallContext, name: string, kind: "command" | "query") {
    const operation = this.contract.operations.get(name);
    if (!operation || operation.kind !== kind) fail("unsupported", "Operation is not supported");
    this.authorize(ctx, operation.meta.effect, operation.meta.channels);
  }

  async start(dir: string) {
    if (this.store || this.lock || this.starting) fail("unavailable", "Engine already started");
    if (!this.registry) fail("internal", "Engine modules were not configured");
    this.starting = true;
    try {
      await mkdir(dir, { recursive: true });
      this.workspace = await realpath(dir);
      const path = join(this.workspace, ".engine.lock");
      try {
        this.lock = await open(path, "wx", 0o600);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        const owner = await readFile(path, "utf8").catch(() => "");
        const pid = Number(owner);
        if (!Number.isInteger(pid) || pid <= 0) fail("unavailable", "Workspace is locked");
        try {
          process.kill(pid, 0);
          fail("unavailable", "Workspace is locked");
        } catch (probe) {
          if (!isCode(probe, "ESRCH")) fail("unavailable", "Workspace is locked");
        }
        await unlink(path);
        this.lock = await open(path, "wx", 0o600);
      }
      await this.lock.writeFile(String(process.pid));
      await this.lock.sync();
      this.store = new SqliteStore(join(this.workspace, "workspace.sqlite"), this.contract);
      this.authentication.configureKey(this.store.accessTokenKey(randomAccessTokenKey));
      await this.authentication.migrateLegacyFile(this.workspace, this.store);
      this.initializeServices();
      this.jobs = new JobRunner(
        this.store,
        this.deps.clock,
        (action) => this.queue.run(() => this.available().transaction(action)),
        {
          leaseMs: 30000,
          handlers: Object.fromEntries(
            [...this.registry.jobKinds].map(([kind, definition]) => [
              kind,
              (job: Job) => definition.run(this.moduleContext(), job),
            ]),
          ),
          lostLeasePolicies: Object.fromEntries(
            [...this.registry.jobKinds].map(([kind, definition]) => [kind, definition.onLostLease]),
          ),
          onInterrupted: (job) => this.registry?.jobKinds.get(job.kind)?.module.recover?.(this.moduleContext()),
          onUncertain: (job) => {
            const payload = job.payload;
            if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
              const reservationId = Reflect.get(payload, "reservationId");
              if (typeof reservationId === "string") this.markReservationUncertain(reservationId);
            }
          },
        },
      );
      await this.queue.run(() =>
        this.available().transaction(() => {
          const context = this.moduleContext();
          for (const engineModule of this.registry!.modules) engineModule.recover?.(context);
          for (const engineModule of this.registry!.modules) engineModule.onStart?.(context);
        }),
      );
      await this.jobs.recover();
      this.accepting = true;
      this.workerTimer = setInterval(() => {
        void this.jobs?.tick();
      }, 15);
      this.workerTimer.unref();
    } catch (error) {
      await this.cleanup();
      throwBoundary(error);
    } finally {
      this.starting = false;
    }
  }

  async drain(graceMs: number) {
    if (!Number.isFinite(graceMs) || graceMs < 0) fail("invalid", "Invalid grace period");
    this.accepting = false;
    await this.queue.idle();
    for (const engineModule of this.registry?.modules ?? []) await engineModule.onDrain?.(this.moduleContext());
    await this.jobs?.drain(graceMs);
  }

  async stop() {
    if (!this.store && !this.lock) return;
    await this.drain(0);
    await this.cleanup();
  }

  protected async cleanup() {
    this.accepting = false;
    if (this.workerTimer) clearInterval(this.workerTimer);
    this.workerTimer = undefined;
    this.store?.close();
    this.store = undefined;
    this.closeServices();
    this.jobs = undefined;
    this.lifecycleContext = undefined;
    this.wake();
    if (this.lock) {
      await this.lock.close();
      this.lock = undefined;
      await unlink(join(this.workspace, ".engine.lock")).catch(() => undefined);
    }
  }

  async command(auth: CallAuth, metadata: CallMetadata, rawCmd: CommandEnvelope): Promise<CommandResult> {
    try {
      const cmd = this.contract.read<CommandEnvelope>("command-envelope", rawCmd);
      if (!this.accepting) fail("unavailable", "Engine is not accepting commands");
      return await this.queue.run(() => {
        const ctx = this.context(auth, metadata);
        this.operation(ctx, cmd.type, "command");
        const store = this.available();
        const existing = store.command(cmd.commandId);
        if (existing) return existing;
        const result = store.transaction(() => {
          let result: CommandResult;
          try {
            const validated = store.transaction(() => {
              const output = this.dispatchCommand(ctx, cmd);
              return this.contract.read<Json>("operations/" + cmd.type, output, "#/properties/result");
            });
            result = { ok: true, result: validated, seq: store.lastSeq() };
          } catch (error) {
            result = { ok: false, error: errorOf(error) };
          }
          const durableResult =
            cmd.type === "sys.CreateAccessToken" && result.ok
              ? this.contract.read<CommandResult>("command-result", {
                  ok: false,
                  error: {
                    code: "uncertain",
                    message: "Access token secret is returned only once",
                    retryable: false,
                  },
                })
              : result;
          store.saveCommand(cmd.commandId, durableResult);
          return result;
        });
        if (result.ok && ["sys.SetSettings", "sys.SetProviderKeyRef", "sys.SetProviderKey"].includes(cmd.type))
          this.settingsChanged();
        this.wake();
        return result;
      });
    } catch (error) {
      return { ok: false, error: errorOf(error) };
    }
  }

  async query(auth: CallAuth, metadata: CallMetadata, rawQ: QueryEnvelope): Promise<Json> {
    try {
      const q = this.contract.read<QueryEnvelope>("query-envelope", rawQ);
      return await this.queue.run(() => {
        const ctx = this.context(auth, metadata);
        this.operation(ctx, q.name, "query");
        const result = this.dispatchQuery(ctx, q);
        return this.contract.read<Json>("operations/" + q.name, result, "#/properties/result");
      });
    } catch (error) {
      throwBoundary(error);
    }
  }

  protected abstract askAgent(raw: unknown): { turnId: string };
  protected abstract initializeServices(): void;
  protected abstract closeServices(): void;
  protected abstract settingsChanged(): void;
  protected abstract gatewayPort(): GatewayPort | undefined;
  protected abstract budgetsPort(): BudgetPort | undefined;
  protected abstract markReservationUncertain(reservationId: string): void;
  protected abstract dispatchOperationCommand(ctx: CallContext, cmd: CommandEnvelope): unknown;
  protected abstract dispatchOperationQuery(ctx: CallContext, query: QueryEnvelope): unknown;
  protected settings(): Settings {
    const value = this.available().feedback("settings", "workspace");
    return this.contract.read<Settings>("settings", value ?? { models: {}, budgets: {}, sessions: {} });
  }
  protected abstract hasJobLease(job: Job): boolean;
  protected abstract queueReplyTurn(
    sessionId: string,
    selected: FeedbackComment[],
    mode: "manual" | "realtime" | "batch",
    threadIds?: string[],
  ): { turnId: string };
  protected abstract runTrigger(job: Job): Promise<void>;
  protected abstract runReply(job: Job): Promise<void>;
  protected abstract runReplyWork(job: Job): Promise<void>;
  protected abstract directEditingEnabled(artifactId: string): boolean;
  protected abstract activeHold(raw: unknown): boolean;
  protected abstract activeUpdateTouches(artifactId: string, elementId: string): boolean;
  protected abstract runUpdateTrigger(job: Job): Promise<void>;
  protected abstract startUpdate(raw: unknown): { updateId: string; status: string };
  protected abstract cancelUpdate(raw: unknown): { updateId: string; status: string };
  protected abstract approvePlan(raw: unknown, commandId: string): { updateId: string; status: string };
  protected abstract runUpdate(job: Job): Promise<void>;
  protected abstract judgeUpdateConflicts(
    update: Update,
    agreements: Agreement[],
  ): Promise<{ agreements: Agreement[]; blocked: Update["itemResults"] }>;
  protected abstract modelJson(
    alias: string,
    schemaName: string,
    update: Update,
    messages: GatewayRequestPort["messages"],
    promptName: string,
  ): Promise<Json | undefined>;
  protected abstract updateSessionId(update: Update): string;
  protected abstract planUpdate(
    update: Update,
    items: Agreement[],
    comments: FeedbackComment[],
    elements: import("../../../contract/src/index.js").Element[],
    alreadyChanged: import("../../../contract/src/index.js").CommitInput["changes"],
  ): Promise<import("../../../contract/src/index.js").UpdatePlan | undefined>;
  protected abstract runUpdateWriter(
    update: Update,
    remaining: Agreement[],
    agreements: Agreement[],
    comments: FeedbackComment[],
    elements: import("../../../contract/src/index.js").Element[],
    direct: import("../../../contract/src/index.js").CommitInput["changes"],
    directResults: Update["itemResults"],
    providedPlan?: import("../../../contract/src/index.js").UpdatePlan,
  ): Promise<void>;
  protected abstract finishUpdate(
    update: Update,
    agreements: Agreement[],
    results: Update["itemResults"],
    changes: import("../../../contract/src/index.js").CommitInput["changes"],
    expectedVersion?: number,
  ): Promise<void>;
  protected abstract dispatchLifecycleCommand(name: string, payload: Json, ctx: CallContext): unknown;
  protected abstract dispatchLifecycleQuery(name: string, args: Json): unknown;
  protected abstract runDigest(job: Job): Promise<void>;
  protected abstract runExport(job: Job): Promise<void>;
  protected abstract runBackup(job: Job): Promise<void>;
  protected abstract runPurge(job: Job): Promise<void>;
  protected abstract runTrashSweep(): Promise<void>;
  protected abstract assertLifecycleVisible(
    kind: "artifact" | "session" | "comment" | "idea" | "project",
    id: string,
    includeTrashed?: boolean,
  ): void;
  protected abstract isLifecycleTrashed(
    kind: "artifact" | "session" | "comment" | "idea" | "project",
    id: string,
  ): boolean;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function throwBoundary(error: unknown): never {
  const e = errorOf(error);
  fail(e.code, e.message, e.details);
}
