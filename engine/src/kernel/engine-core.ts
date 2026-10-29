import { open, mkdir, readFile, unlink, realpath, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Contract, CONTRACT_VERSION, errorOf, fail } from "../../../contract/src/index.js";
import type {
  CallContext,
  CommandEnvelope,
  CommandResult,
  EventEnvelope,
  Json,
  QueryEnvelope,
  Subscription,
  ProviderModel,
  AgentTurn,
  ContextManifest,
  FeedbackComment,
  Agreement,
  Update,
  Job,
  VcCreateArtifactOperation,
  VcImportContentOperation,
  VcRestoreVersionOperation,
  VcArtifactOperation,
  VcOutlineOperation,
  VcElementsOperation,
  VcDiffOperation,
  VcResolveAnchorsOperation,
} from "../../../contract/src/index.js";
import { unsupportedGroups } from "../../../contract/src/catalog.js";
import { SqliteStore } from "../storage/sqlite.js";
import { Content } from "../content/content.js";
import { outline, diffVersions, resolveAnchors } from "../content/diff.js";

import type { Dependencies } from "./dependencies.js";
import { SerialQueue } from "./queue.js";
import { JobRunner } from "./jobs.js";
import { Feedback } from "../feedback/feedback.js";
import { BudgetLedger } from "../gateway/ledger.js";
import { ProviderGateway } from "../gateway/gateway.js";
import { OpenAICompatibleProvider } from "../gateway/providers/openai-compatible.js";

import { createHash } from "node:crypto";
import type { ModelRequest as GatewayRequest } from "../gateway/types.js";
import type { SettingsDocument } from "../gateway/types.js";
import { createGrant, revokeGrant } from "../agent/grants.js";

export abstract class EngineCore {
  protected readonly contract = new Contract();

  protected readonly queue = new SerialQueue();

  protected store: SqliteStore | undefined;

  protected content: Content | undefined;

  protected jobs: JobRunner | undefined;

  protected feedback: Feedback | undefined;

  protected budgets: BudgetLedger | undefined;

  protected gateway: ProviderGateway | undefined;

  protected lock: FileHandle | undefined;

  protected workspace = "";

  protected accepting = false;

  protected starting = false;

  protected readonly listeners = new Set<() => void>();

  protected workerTimer: ReturnType<typeof setInterval> | undefined;

  protected readonly sessionTails = new Map<string, Promise<void>>();

  constructor(protected readonly deps: Dependencies) {}

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

  protected recoverInterruptedJob(job: Job): void {
    const store = this.available(),
      payload = job.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    if (job.kind === "agent.update") {
      const updateId = Reflect.get(payload, "updateId");
      if (typeof updateId !== "string") return;
      const raw = store.feedback("update", updateId);
      if (!raw) return;
      const update = this.contract.read<Update>("update", raw);
      this.budgets?.markTurnUncertain(updateId);
      if (["committed", "partially_committed", "failed", "cancelled"].includes(update.status)) return;
      for (const itemId of update.itemIds) {
        const row = store.feedback("agreement", itemId);
        if (row) {
          const agreement = this.contract.read<Agreement>("agreement", row);
          if (agreement.state === "scheduled")
            store.saveFeedback(
              "agreement",
              itemId,
              this.contract.read<Json>("json", {
                ...agreement,
                state: "agreed",
              }),
            );
        }
      }
      store.saveFeedback(
        "update",
        updateId,
        this.contract.read<Json>("json", {
          ...update,
          status: "failed",
          itemResults: update.itemIds.map((itemId) => ({
            itemId,
            status: "not_addressed",
            reason: "Update was interrupted; no changes were committed.",
          })),
        }),
      );
    } else if (job.kind === "agent.reply") {
      const turnId = Reflect.get(payload, "turnId");
      if (typeof turnId !== "string") return;
      const raw = store.feedback("agent-turn", turnId);
      if (!raw) return;
      const turn = this.contract.read<AgentTurn>("agent-turn", raw);
      if (turn.status === "queued")
        store.enqueue(
          "agent.reply",
          this.deps.ids.next("reply_retry_"),
          this.contract.read<Json>("json", payload),
          this.deps.clock.now(),
        );
      else if (turn.status === "running")
        store.saveFeedback(
          "agent-turn",
          turnId,
          this.contract.read<Json>("json", {
            ...turn,
            status: "uncertain",
            completedAt: this.deps.clock.now(),
          }),
        );
    }
  }

  private recoverAwaitingPlanReviews(): void {
    const store = this.available();
    for (const raw of store.feedbackList("update")) {
      const update = this.contract.read<Update>("update", raw);
      if (update.status !== "awaiting_plan_review") continue;
      for (const itemId of update.itemIds) {
        const agreementRaw = store.feedback("agreement", itemId);
        if (!agreementRaw) continue;
        const agreement = this.contract.read<Agreement>("agreement", agreementRaw);
        if (agreement.state === "scheduled")
          store.saveFeedback("agreement", itemId, this.contract.read<Json>("json", { ...agreement, state: "agreed" }));
      }
      store.saveFeedback(
        "update",
        update.updateId,
        this.contract.read<Json>("json", {
          ...update,
          status: "failed",
          itemResults: update.itemIds.map((itemId) => ({
            itemId,
            status: "not_addressed",
            reason: "Update was interrupted while awaiting plan review; no changes were committed.",
          })),
        }),
      );
    }
  }

  protected context(raw: unknown) {
    const ctx = this.contract.read<CallContext>("call-context", raw);
    if (ctx.contractVersion !== CONTRACT_VERSION) fail("unsupported", "Contract version is not supported");
    return ctx;
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
      this.content = new Content(this.store, this.contract, this.deps.clock, this.deps.ids);
      this.feedback = new Feedback(this.store, this.contract, this.deps.clock, this.deps.ids, () => this.settings());
      this.budgets = new BudgetLedger(
        this.store,
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
      this.jobs = new JobRunner(
        this.store,
        this.deps.clock,
        (action) => this.queue.run(() => this.available().transaction(action)),
        {
          leaseMs: 30000,
          handlers: {
            "agent.reply": (job) => this.runReply(job),
            "agent.trigger": (job) => this.runTrigger(job),
            "agent.update.trigger": (job) => this.runUpdateTrigger(job),
            "agent.update": (job) => this.runUpdate(job),
          },
          onInterrupted: (job) => this.recoverInterruptedJob(job),
          onUncertain: (job) => {
            const payload = job.payload;
            if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
              const reservationId = Reflect.get(payload, "reservationId");
              if (typeof reservationId === "string") this.budgets?.markUncertain(reservationId);
              if (job.kind === "agent.reply") {
                const turnId = Reflect.get(payload, "turnId");
                if (typeof turnId === "string") {
                  const raw = this.available().feedback("agent-turn", turnId);
                  if (raw) {
                    const turn = this.contract.read<AgentTurn>("agent-turn", raw);
                    if (turn.status === "running")
                      this.available().saveFeedback(
                        "agent-turn",
                        turnId,
                        this.contract.read<Json>("json", {
                          ...turn,
                          status: "uncertain",
                          completedAt: this.deps.clock.now(),
                        }),
                      );
                  }
                }
              }
            }
          },
        },
      );
      await this.jobs.recover();
      await this.queue.run(() => this.available().transaction(() => this.recoverAwaitingPlanReviews()));
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
    this.content = undefined;
    this.feedback = undefined;
    this.budgets = undefined;
    this.gateway = undefined;
    this.jobs = undefined;
    this.wake();
    if (this.lock) {
      await this.lock.close();
      this.lock = undefined;
      await unlink(join(this.workspace, ".engine.lock")).catch(() => undefined);
    }
  }

  async command(rawCtx: CallContext, rawCmd: CommandEnvelope): Promise<CommandResult> {
    try {
      const ctx = this.context(rawCtx),
        cmd = this.contract.read<CommandEnvelope>("command-envelope", rawCmd);
      this.operation(ctx, cmd.type, "command");
      if (!this.accepting) fail("unavailable", "Engine is not accepting commands");
      return await this.queue.run(() => {
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
          store.saveCommand(cmd.commandId, result);
          return result;
        });
        if (result.ok && (cmd.type === "sys.SetSettings" || cmd.type === "sys.SetProviderKeyRef"))
          this.gateway?.setModels(this.settings().models);
        this.wake();
        return result;
      });
    } catch (error) {
      return { ok: false, error: errorOf(error) };
    }
  }

  protected dispatchCommand(ctx: CallContext, cmd: CommandEnvelope): unknown {
    const content = this.content;
    const store = this.store;
    if (!content || !store) fail("unavailable", "Engine is stopped");
    switch (cmd.type) {
      case "sys.SetSettings": {
        const p = this.contract.read<{
          patch: {
            models?: Record<string, ProviderModel>;
            budgets?: SettingsDocument["budgets"];
            sessions?: Record<string, Json>;
          };
        }>("operations/sys.SetSettings", cmd.payload, "#/properties/payload");
        const current = this.settings(),
          budgets = { ...current.budgets, ...p.patch.budgets };
        if (budgets.localTimeZone !== undefined) {
          try {
            new Intl.DateTimeFormat("en", { timeZone: budgets.localTimeZone });
          } catch {
            fail("invalid", "Invalid local time zone");
          }
        }
        const settings = this.saveSettings({
          models: { ...current.models, ...p.patch.models },
          budgets,
          sessions: { ...current.sessions, ...p.patch.sessions },
        });
        store.appendEvent({
          ts: this.deps.clock.now(),
          type: "sys.SettingsChanged",
          entity: { kind: "settings", id: "workspace" },
          payload: this.contract.read<Json>("events/sys.SettingsChanged", {
            settings,
          }),
        });
        return { settings };
      }
      case "sys.SetProviderKeyRef": {
        const p = this.contract.read<{ alias: string; keyRef: string }>(
            "operations/sys.SetProviderKeyRef",
            cmd.payload,
            "#/properties/payload",
          ),
          current = this.settings(),
          model = current.models[p.alias];
        if (!model) fail("not_found", "Model alias not found");
        this.saveSettings({
          ...current,
          models: {
            ...current.models,
            [p.alias]: { ...model, keyRef: p.keyRef },
          },
        });
        store.appendEvent({
          ts: this.deps.clock.now(),
          type: "sys.ProviderKeyRefSet",
          entity: { kind: "model", id: p.alias },
          payload: this.contract.read<Json>("events/sys.ProviderKeyRefSet", p),
        });
        return p;
      }
      case "sys.SetBudget": {
        const p = this.contract.read<{
          account: {
            kind: "daily" | "session" | "grant" | "run" | "turn";
            key?: string;
          };
          limitMicros: number | null;
        }>("operations/sys.SetBudget", cmd.payload, "#/properties/payload");
        const budgets = this.budgets;
        if (!budgets) fail("unavailable", "Budget ledger is not started");
        const state = budgets.setLimit(p.account, p.limitMicros);
        store.appendEvent({
          ts: this.deps.clock.now(),
          type: "sys.BudgetChanged",
          entity: {
            kind: "budget",
            id: `${state.account.kind}:${state.account.key ?? ""}`,
          },
          payload: this.contract.read<Json>("events/sys.BudgetChanged", {
            account: state.account,
            limitMicros: state.limitMicros,
          }),
        });
        return { state };
      }
      case "vc.CreateArtifact": {
        const p = this.contract.read<VcCreateArtifactOperation["payload"]>(
          "operations/" + cmd.type,
          cmd.payload,
          "#/properties/payload",
        );
        return content.create(p.title, ctx.principal);
      }
      case "vc.ImportContent": {
        const p = this.contract.read<VcImportContentOperation["payload"]>(
          "operations/" + cmd.type,
          cmd.payload,
          "#/properties/payload",
        );
        const r = content.import(p, ctx.principal);
        return {
          artifactId: r.artifactId,
          version: r.version,
          ...("idMap" in r ? { idMap: r.idMap } : {}),
        };
      }
      case "vc.RestoreVersion": {
        const p = this.contract.read<VcRestoreVersionOperation["payload"]>(
          "operations/" + cmd.type,
          cmd.payload,
          "#/properties/payload",
        );
        const r = content.restore(p.artifactId, p.version, ctx.principal);
        for (const agreement of store
          .feedbackList("agreement")
          .map((x) => this.contract.read<Agreement>("agreement", x))
          .filter((a) => a.state === "applied" && a.appliedVersion !== undefined && a.appliedVersion > p.version)) {
          const rawComment = store.feedback("comment", agreement.commentId);
          if (!rawComment) continue;
          const comment = this.contract.read<FeedbackComment>("feedback-comment", rawComment);
          if (comment.anchor?.artifactId !== p.artifactId) continue;
          store.saveFeedback(
            "agreement",
            agreement.agreementId,
            this.contract.read<Json>("agreement", {
              ...agreement,
              revertedInVersion: r.version,
            }),
          );
          this.feedback?.systemNotice(
            comment.sessionId,
            comment.threadId,
            `The Update applied in version ${agreement.appliedVersion} was reverted by restoring version ${p.version}. Re-agree if you still want this change.`,
          );
        }
        return { artifactId: r.artifactId, version: r.version };
      }
      case "vc.CaptureIdea":
      case "vc.CreateProject":
      case "vc.StartSession":
      case "vc.AttachArtifact":
      case "vc.PauseSession":
      case "vc.ResumeSession":
      case "vc.EndSession":
      case "vc.Comment":
      case "vc.EditComment":
      case "vc.DeleteComment":
      case "vc.Agree":
      case "vc.Decline":
      case "vc.ResolveConflict":
      case "vc.SetReplyTrigger":
      case "vc.MarkHandled":
        if (!this.feedback) fail("unavailable", "Engine is stopped");
        return this.feedback.command(cmd.type, cmd.payload, ctx.principal);
      case "vc.CreateGrant": {
        return createGrant(store, this.contract, this.deps.ids, ctx.principal, cmd.payload);
      }
      case "vc.RevokeGrant": {
        return revokeGrant(store, this.contract, this.deps.clock, ctx.principal, cmd.payload);
      }
      case "vc.AskAgent":
        if (ctx.principal.kind !== "human") fail("forbidden", "AskAgent requires a human principal");
        return this.askAgent(cmd.payload);
      case "vc.StartUpdate":
        if (ctx.principal.kind !== "human") fail("forbidden", "StartUpdate requires a human principal");
        return this.startUpdate(cmd.payload);
      case "vc.HoldElement": {
        if (ctx.principal.kind !== "human") fail("forbidden", "Direct editing requires a human principal");
        const p = this.contract.read<{ artifactId: string; elementId: string }>(
          "operations/vc.HoldElement",
          cmd.payload,
          "#/properties/payload",
        );
        if (!this.directEditingEnabled(p.artifactId)) fail("forbidden", "Direct editing is disabled for this artifact");
        if (this.activeUpdateTouches(p.artifactId, p.elementId))
          fail("locked", "Element is in an active Update write set");
        const element = store.elements(p.artifactId).find((x) => x.elementId === p.elementId);
        if (!element) fail("not_found", "Element not found");
        const key = `${p.artifactId}:${p.elementId}`,
          existing = store.feedback("hold", key);
        if (existing && this.activeHold(existing)) fail("locked", "Element is already held");
        const now = this.deps.clock.now();
        store.saveFeedback(
          "hold",
          key,
          this.contract.read<Json>("hold", {
            ...p,
            heldAt: now,
            lastActivity: now,
          }),
        );
        return { ...p, heldAt: now };
      }
      case "vc.SaveElement": {
        if (ctx.principal.kind !== "human") fail("forbidden", "Direct editing requires a human principal");
        const p = this.contract.read<{
          artifactId: string;
          elementId: string;
          baseVersion: number;
          element: import("../../../contract/src/index.js").ElementDraft;
        }>("operations/vc.SaveElement", cmd.payload, "#/properties/payload");
        if (!this.directEditingEnabled(p.artifactId)) fail("forbidden", "Direct editing is disabled for this artifact");
        if (this.activeUpdateTouches(p.artifactId, p.elementId))
          fail("locked", "Element is in an active Update write set");
        const key = `${p.artifactId}:${p.elementId}`,
          rawHold = store.feedback("hold", key);
        if (!rawHold || !this.activeHold(rawHold)) fail("locked", "A current element hold is required");
        const current = store.elements(p.artifactId, p.baseVersion).find((x) => x.elementId === p.elementId);
        if (!current) fail("not_found", "Element not found at base version");
        const committed = content.commit({
          artifactId: p.artifactId,
          baseVersion: p.baseVersion,
          changes: [{ op: "update", elementId: p.elementId, element: p.element }],
          createdBy: ctx.principal,
          source: { editId: this.deps.ids.next("edit_") },
        });
        const hold = this.contract.read<{
          artifactId: string;
          elementId: string;
          heldAt: string;
          lastActivity: string;
        }>("hold", rawHold);
        store.saveFeedback(
          "hold",
          key,
          this.contract.read<Json>("hold", {
            ...hold,
            lastActivity: this.deps.clock.now(),
          }),
        );
        return {
          artifactId: p.artifactId,
          elementId: p.elementId,
          version: committed.version,
        };
      }
      case "vc.ReleaseHold": {
        if (ctx.principal.kind !== "human") fail("forbidden", "Direct editing requires a human principal");
        const p = this.contract.read<{ artifactId: string; elementId: string }>(
            "operations/vc.ReleaseHold",
            cmd.payload,
            "#/properties/payload",
          ),
          key = `${p.artifactId}:${p.elementId}`,
          rawHold = store.feedback("hold", key);
        if (!rawHold) fail("not_found", "Element hold not found");
        const hold = this.contract.read<Record<string, Json>>("hold", rawHold);
        store.saveFeedback(
          "hold",
          key,
          this.contract.read<Json>("hold", {
            ...hold,
            releasedAt: this.deps.clock.now(),
          }),
        );
        return p;
      }
      case "vc.CancelUpdate":
        if (ctx.principal.kind !== "human") fail("forbidden", "CancelUpdate requires a human principal");
        return this.cancelUpdate(cmd.payload);
      case "vc.ApprovePlan":
        if (ctx.principal.kind !== "human") fail("forbidden", "ApprovePlan requires a human principal");
        return this.approvePlan(cmd.payload, cmd.commandId);
      default:
        fail("unsupported", "Operation is not supported");
    }
  }

  async query(rawCtx: CallContext, rawQ: QueryEnvelope): Promise<Json> {
    try {
      const ctx = this.context(rawCtx),
        q = this.contract.read<QueryEnvelope>("query-envelope", rawQ);
      this.operation(ctx, q.name, "query");
      await this.queue.idle();
      const result = this.dispatchQuery(q);
      return this.contract.read<Json>("operations/" + q.name, result, "#/properties/result");
    } catch (error) {
      throwBoundary(error);
    }
  }

  protected dispatchQuery(q: QueryEnvelope): unknown {
    const store = this.available();
    const read = <T>() => this.contract.read<T>("operations/" + q.name, q.args, "#/properties/payload");
    switch (q.name) {
      case "sys.Capabilities": {
        read();
        const operations = [...this.contract.operations].map(([name, operation]) => ({
          name,
          ...operation,
          supported: true,
        }));
        for (const group of unsupportedGroups)
          for (const kind of ["command", "query"] satisfies ("command" | "query")[])
            for (const name of (kind === "command" ? group.commands : group.queries).split(" ").filter(Boolean)) {
              const effect = kind === "query" ? "read" : (group.effect ?? "collaborate");
              operations.push({
                name: group.prefix + "." + name,
                kind,
                supported: false,
                meta: {
                  effect,
                  irreversible: ["Purge", "RestoreBackup"].includes(name),
                  channels: effect === "admin" ? ["in_process", "http", "cli"] : ["in_process", "http", "cli", "mcp"],
                },
              });
            }
        return {
          contractVersion: CONTRACT_VERSION,
          mediaKinds: ["doc"],
          operations,
        };
      }
      case "vc.Artifact":
        return store.artifact(read<VcArtifactOperation["payload"]>().artifactId);
      case "vc.Outline": {
        const p = read<VcOutlineOperation["payload"]>();
        return outline(store.elements(p.artifactId, p.version));
      }
      case "vc.Elements": {
        const p = read<VcElementsOperation["payload"]>(),
          elements = store.elements(p.artifactId, p.version);
        return p.elementIds ? elements.filter((e) => p.elementIds!.includes(e.elementId)) : elements;
      }
      case "vc.Versions":
        return store.versions(read<VcArtifactOperation["payload"]>().artifactId);
      case "vc.Diff": {
        const p = read<VcDiffOperation["payload"]>();
        return diffVersions(store, p.artifactId, p.from, p.to);
      }
      case "vc.ResolveAnchors":
        return resolveAnchors(store, read<VcResolveAnchorsOperation["payload"]>().anchors);
      case "sys.Settings":
        read();
        return this.settings();
      case "sys.Usage": {
        read();
        const budgets = this.budgets;
        if (!budgets) fail("unavailable", "Budget ledger is not started");
        return { accounts: budgets.states(), calls: budgets.calls() };
      }
      case "sys.Budgets": {
        read();
        const budgets = this.budgets;
        if (!budgets) fail("unavailable", "Budget ledger is not started");
        return budgets.states();
      }
      case "vc.Ideas":
      case "vc.Projects":
      case "vc.Sessions":
      case "vc.Threads":
      case "vc.FeedbackItems":
      case "vc.DecisionRecord":
      case "vc.Conflicts":
      case "vc.AttentionInbox":
        if (!this.feedback) fail("unavailable", "Engine is stopped");
        return this.feedback.query(q.name, q.args);
      case "vc.AgentTurns":
      case "vc.Manifest":
      case "vc.DeliveryState":
      case "vc.Grants": {
        this.contract.read("operations/" + q.name, q.args, "#/properties/payload");
        if (q.name === "vc.AgentTurns") {
          const p = this.contract.read<{ sessionId?: string }>(
            "operations/vc.AgentTurns",
            q.args,
            "#/properties/payload",
          );
          return store
            .feedbackList("agent-turn")
            .map((x) => this.contract.read<AgentTurn>("agent-turn", x))
            .filter((x) => !p.sessionId || x.sessionId === p.sessionId);
        }
        if (q.name === "vc.Manifest") {
          const p = this.contract.read<{ turnId: string }>("operations/vc.Manifest", q.args, "#/properties/payload");
          return store
            .feedbackList("manifest")
            .map((x) => this.contract.read<ContextManifest>("context-manifest", x))
            .filter((x) => x.turnId === p.turnId);
        }
        if (q.name === "vc.Grants") return store.feedbackList("grant");
        const p = this.contract.read<{ commentIds: string[] }>(
          "operations/vc.DeliveryState",
          q.args,
          "#/properties/payload",
        );
        return p.commentIds.map(
          (commentId) =>
            store.feedback("delivery-state", commentId) ?? {
              commentId,
              state: "saved",
              updatedAt: this.deps.clock.now(),
            },
        );
      }
      case "vc.Updates":
      case "vc.UpdateDetail": {
        if (q.name === "vc.Updates") {
          const p = this.contract.read<{ artifactId?: string }>(
            "operations/vc.Updates",
            q.args,
            "#/properties/payload",
          );
          return store
            .feedbackList("update")
            .map((x) => this.contract.read<Update>("update", x))
            .filter((x) => !p.artifactId || x.artifactId === p.artifactId);
        }
        const p = this.contract.read<{ updateId: string }>(
          "operations/vc.UpdateDetail",
          q.args,
          "#/properties/payload",
        );
        const found = store.feedback("update", p.updateId);
        if (!found) fail("not_found", "Update not found");
        return this.contract.read<Update>("update", found);
      }
      default:
        fail("unsupported", "Operation is not supported");
    }
  }

  protected settings(): SettingsDocument {
    const value = this.available().feedback("settings", "workspace");
    return this.contract.read<SettingsDocument>("settings", value ?? { models: {}, budgets: {}, sessions: {} });
  }

  protected saveSettings(value: unknown): SettingsDocument {
    const settings = this.contract.read<SettingsDocument>("settings", value);
    this.available().saveFeedback("settings", "workspace", this.contract.read<Json>("json", settings));
    return settings;
  }

  subscribe(rawCtx: CallContext, rawSub: Subscription): AsyncIterable<EventEnvelope> {
    const currentStore = () => this.store;
    const listeners = this.listeners;
    let ctx: CallContext, sub: Subscription;
    try {
      ctx = this.context(rawCtx);
      sub = this.contract.read<Subscription>("subscription", rawSub);
      this.authorize(ctx, "read");
      this.available();
    } catch (error) {
      throwBoundary(error);
    }
    let cursor = sub.afterSeq,
      ended = false,
      wakeup: (() => void) | undefined;
    const iterator: AsyncIterableIterator<EventEnvelope> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        try {
          while (!ended && currentStore()) {
            for (const event of currentStore()!.eventsAfter(cursor)) {
              cursor = event.seq;
              const filter = sub.filter;
              if (filter?.types && !filter.types.includes(event.type)) continue;
              if (
                filter?.artifactIds &&
                (event.entity.kind !== "artifact" || !filter.artifactIds.includes(event.entity.id))
              )
                continue;
              if (filter?.sessionIds) continue;
              return { done: false, value: event };
            }
            await new Promise<void>((resolve) => {
              wakeup = () => {
                listeners.delete(wakeup!);
                resolve();
              };
              listeners.add(wakeup);
            });
          }
          return { done: true, value: undefined };
        } catch (error) {
          throwBoundary(error);
        }
      },
      async return() {
        ended = true;
        wakeup?.();
        return { done: true, value: undefined };
      },
    };
    return iterator;
  }

  async putBlob(rawCtx: CallContext, bytes: Uint8Array, mediaType: string): Promise<string> {
    try {
      const ctx = this.context(rawCtx);
      this.authorize(ctx, "collaborate");
      this.available();
      if (!this.accepting) fail("unavailable", "Engine is draining");
      if (!(bytes instanceof Uint8Array) || typeof mediaType !== "string" || !mediaType.length)
        fail("invalid", "Invalid blob");
      const snapshot = Uint8Array.from(bytes),
        hash = createHash("sha256").update(snapshot).digest("hex");
      await this.queue.run(async () => {
        const dir = join(this.workspace, "blobs", hash.slice(0, 2), hash.slice(2, 4));
        await mkdir(dir, { recursive: true });
        const path = join(dir, hash),
          temporary = join(dir, hash + "." + this.deps.ids.next("blob_"));
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(snapshot);
          await file.sync();
          await file.close();
          await rename(temporary, path);
        } catch (error) {
          await file.close().catch(() => undefined);
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
      });
      return hash;
    } catch (error) {
      throwBoundary(error);
    }
  }

  async getBlob(rawCtx: CallContext, hash: string): Promise<Uint8Array> {
    try {
      const ctx = this.context(rawCtx);
      this.authorize(ctx, "read");
      this.available();
      if (!/^[a-f0-9]{64}$/.test(hash)) fail("invalid", "Invalid blob hash");
      await this.queue.idle();
      const bytes = await readFile(join(this.workspace, "blobs", hash.slice(0, 2), hash.slice(2, 4), hash));
      if (createHash("sha256").update(bytes).digest("hex") !== hash) fail("internal", "Blob integrity check failed");
      return new Uint8Array(bytes);
    } catch (error) {
      if (isCode(error, "ENOENT")) fail("not_found", "Blob not found");
      throwBoundary(error);
    }
  }
  protected abstract askAgent(raw: unknown): { turnId: string };
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
    messages: GatewayRequest["messages"],
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
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function throwBoundary(error: unknown): never {
  const e = errorOf(error);
  fail(e.code, e.message, e.details);
}
