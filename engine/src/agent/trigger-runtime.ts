import { fail } from "../../../contract/src/index.js";
import type { Json, AgentTurn, FeedbackComment, Job } from "../../../contract/src/index.js";
import { AgentServicesRuntime } from "./services-runtime.js";

export abstract class AgentTriggerRuntime extends AgentServicesRuntime {
  protected askAgent(raw: unknown): { turnId: string } {
    const store = this.available(),
      p = this.contract.read<{ sessionId: string; threadIds?: string[] }>(
        "operations/vc.AskAgent",
        raw,
        "#/properties/payload",
      );
    const session = store.feedback("session", p.sessionId);
    if (!session) fail("not_found", "Session not found");
    const sessionRecord = this.contract.read<Record<string, Json>>("session", session);
    if (sessionRecord.state !== "active") fail("conflict", "Agent replies require an active session");
    const all = store.feedbackList("comment").map((x) => this.contract.read<FeedbackComment>("feedback-comment", x));
    const selected = all.filter(
      (c) =>
        c.sessionId === p.sessionId &&
        !c.deleted &&
        c.author.kind === "human" &&
        (p.threadIds === undefined || p.threadIds.includes(c.threadId)),
    );
    if (!selected.length) fail("not_found", "No human comments match the requested threads");
    return this.queueReplyTurn(p.sessionId, selected, "manual", p.threadIds);
  }

  protected hasJobLease(job: Job): boolean {
    const current = this.available()
      .jobs()
      .find((candidate) => candidate.id === job.id);
    return current?.state === "leased" && current.attempts === job.attempts;
  }

  protected queueReplyTurn(
    sessionId: string,
    selected: FeedbackComment[],
    mode: "manual" | "realtime" | "batch",
    threadIds?: string[],
  ): { turnId: string } {
    const store = this.available(),
      turnId = this.deps.ids.next("turn_"),
      settings = this.settings(),
      modelRef = settings.models.reply ? "reply" : "default";
    const turn = this.contract.read<AgentTurn>("agent-turn", {
      turnId,
      sessionId,
      kind: "reply",
      trigger: {
        mode,
        commentIds: selected.map((c) => c.commentId),
        ...(threadIds ? { threadIds } : {}),
      },
      manifestId: this.deps.ids.next("manifest_"),
      status: "queued",
      createdAt: this.deps.clock.now(),
      updatedAt: this.deps.clock.now(),
    });
    store.saveFeedback("agent-turn", turnId, this.contract.read<Json>("json", turn));
    for (const c of selected)
      store.saveFeedback(
        "delivery-state",
        c.commentId,
        this.contract.read<Json>("delivery-state", {
          commentId: c.commentId,
          state: "queued",
          turnId,
          updatedAt: this.deps.clock.now(),
        }),
      );
    store.enqueue("agent.reply", turnId, this.contract.read<Json>("json", { turnId, modelRef }), this.deps.clock.now());
    return { turnId };
  }

  protected async runTrigger(job: Job): Promise<void> {
    const payload = job.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const sessionId = Reflect.get(payload, "sessionId"),
      mode = Reflect.get(payload, "mode");
    if (typeof sessionId !== "string" || (mode !== "realtime" && mode !== "batch")) return;
    await this.queue.run(() =>
      this.available().transaction(() => {
        const store = this.available(),
          active = store
            .feedbackList("agent-turn")
            .map((x) => this.contract.read<AgentTurn>("agent-turn", x))
            .some((t) => t.sessionId === sessionId && ["queued", "running"].includes(t.status));
        const comments = store
          .feedbackList("comment")
          .map((x) => this.contract.read<FeedbackComment>("feedback-comment", x))
          .filter(
            (c) =>
              c.sessionId === sessionId &&
              c.author.kind === "human" &&
              !c.deleted &&
              this.contract.read<{
                commentId: string;
                state: string;
                updatedAt: string;
              }>(
                "delivery-state",
                store.feedback("delivery-state", c.commentId) ?? {
                  commentId: c.commentId,
                  state: "saved",
                  updatedAt: c.createdAt,
                },
              ).state === "saved",
          );
        if (!comments.length) return;
        if (active) {
          store.enqueue(
            "agent.trigger",
            this.deps.ids.next("trigger_"),
            this.contract.read<Json>("json", {
              sessionId,
              mode,
              notBefore: new Date(Date.parse(this.deps.clock.now()) + 1000).toISOString(),
            }),
            this.deps.clock.now(),
          );
          return;
        }
        const now = Date.parse(this.deps.clock.now()),
          prefs = this.settings().sessions[sessionId] ?? {},
          storedTrigger = store.feedback("session-trigger", sessionId),
          batch = storedTrigger
            ? this.contract.read<import("../../../contract/src/index.js").ReplyTrigger>("reply-trigger", storedTrigger)
                .batch
            : undefined,
          latest = Math.max(...comments.map((c) => Date.parse(c.createdAt)));
        let effectiveMode: "realtime" | "batch" = mode;
        const recentTurns = store
          .feedbackList("agent-turn")
          .map((x) => this.contract.read<AgentTurn>("agent-turn", x))
          .filter(
            (t) =>
              t.sessionId === sessionId && t.trigger.mode === "realtime" && now - Date.parse(t.createdAt) < 3_600_000,
          ).length;
        const rateLimit = prefs.replyRateLimitPerHour ?? 20;
        if (mode === "realtime" && recentTurns >= rateLimit) {
          effectiveMode = "batch";
          this.feedback?.systemNotice(
            sessionId,
            comments[0]!.threadId,
            "Realtime replies reached the session rate limit. New comments will be handled in batch mode.",
          );
        }
        if (
          effectiveMode === "realtime" &&
          now < latest + (prefs.realtimeDebounceSeconds ?? this.settings().budgets.realtimeDebounceSeconds ?? 8) * 1000
        )
          return;
        if (
          effectiveMode === "batch" &&
          comments.length < (batch?.count ?? prefs.batchCommentThreshold ?? 5) &&
          now < latest + (batch?.idleMinutes ?? prefs.batchIdleMinutes ?? 10) * 60_000
        )
          return;
        this.queueReplyTurn(sessionId, comments, effectiveMode);
      }),
    );
  }
}
