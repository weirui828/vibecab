import { fail, type Contract } from "../../../contract/src/index.js";
import { inlineMarkdownToPlainText } from "../../../contract/src/inline-markdown.js";
import type {
  Agreement,
  Anchor,
  CallContext,
  FeedbackComment,
  Session,
  Json,
  Settings,
  VcCommentOperation,
  ReplyTrigger,
} from "../../../contract/src/index.js";
import type { Clock, IdGenerator } from "../dependencies.js";
import type { Repository } from "../storage/repository.js";
import { sessionPreferences } from "../session-preferences.js";
export type FeedbackInput = VcCommentOperation["payload"];
export abstract class FeedbackCoreRuntime {
  constructor(
    protected readonly store: Repository,
    protected readonly contract: Contract,
    protected readonly clock: Clock,
    protected readonly ids: IdGenerator,
    protected readonly settings: () => Settings,
  ) {}

  protected save<T>(kind: string, schema: string, id: string, value: unknown): T {
    const checked = this.contract.read<T>(schema, value);
    this.store.saveFeedback(kind, id, this.contract.read<Json>("json", checked));
    return checked;
  }

  protected get<T>(kind: string, schema: string, id: string): T {
    const value = this.store.feedback(kind, id);
    if (value === undefined) fail("not_found", "Feedback item not found");
    return this.contract.read<T>(schema, value);
  }
  protected list<T>(kind: string, schema: string): T[] {
    return this.store.feedbackList(kind).map((value) => this.contract.read<T>(schema, value));
  }
  protected session(id: string): Session {
    return this.get("session", "session", id);
  }
  protected comment(id: string): FeedbackComment {
    return this.get("comment", "feedback-comment", id);
  }
  protected agreement(id: string): Agreement {
    return this.get("agreement", "agreement", id);
  }
  protected event(type: string, entity: { kind: string; id: string }, payload: unknown) {
    this.store.appendEvent({
      ts: this.clock.now(),
      type,
      entity,
      payload: this.contract.read<Json>("events/" + type, payload),
    });
  }
  protected editable(c: FeedbackComment) {
    if (this.session(c.sessionId).state === "ended") fail("conflict", "Ended sessions are read-only");
    if (c.deleted || !["open", "discussing"].includes(c.state))
      fail("conflict", "Feedback item can no longer be changed");
  }
  protected post(p: FeedbackInput, channel: CallContext["channel"]): { commentId: string; threadId: string } {
    const session = this.session(p.sessionId);
    if (session.state !== "active") fail("conflict", "Comments require an active session");
    let anchor: Anchor | undefined;
    if (p.anchor) {
      const link = this.store.feedback("attachment", `${p.sessionId}:${p.anchor.artifactId}`);
      if (link === undefined) fail("invalid", "Anchor artifact is not attached to this session");
      const version = this.store.version(p.anchor.artifactId, p.anchor.seenVersion),
        hash = version.manifest[p.anchor.elementId];
      if (hash === undefined) fail("invalid", "Anchor element is absent at seenVersion");
      const seenElement = this.store
        .elements(p.anchor.artifactId, p.anchor.seenVersion)
        .find((e) => e.elementId === p.anchor!.elementId);
      if (!seenElement) fail("invalid", "Anchor element is absent at seenVersion");
      if (
        p.anchor.locator &&
        (!("text" in seenElement) || !inlineMarkdownToPlainText(seenElement.text).includes(p.anchor.locator.quote))
      )
        fail("invalid", "Anchor quote must match text at seenVersion");
      anchor = this.contract.read<Anchor>("anchor", {
        artifactId: p.anchor.artifactId,
        elementId: p.anchor.elementId,
        seenVersion: p.anchor.seenVersion,
        seenHash: hash,
        ...(p.anchor.locator === undefined ? {} : { locator: p.anchor.locator }),
      });
    } else if (p.suggestion) fail("invalid", "A suggestion requires a text quote anchor");
    if (p.suggestion && !anchor?.locator?.quote) fail("invalid", "A suggestion requires a text quote anchor");
    let threadId = this.ids.next("thread_");
    if (p.replyTo) {
      const parent = this.comment(p.replyTo);
      if (parent.sessionId !== p.sessionId) fail("invalid", "Reply must belong to the same session");
      this.editable(parent);
      threadId = parent.threadId;
      if (parent.state === "open") {
        this.save<FeedbackComment>("comment", "feedback-comment", parent.commentId, {
          ...parent,
          state: "discussing",
          updatedAt: this.clock.now(),
        });
        this.event(
          "vc.FeedbackStateChanged",
          { kind: "comment", id: parent.commentId },
          {
            commentId: parent.commentId,
            sessionId: parent.sessionId,
            state: "discussing",
          },
        );
      }
    }
    const commentId = this.ids.next("comment_"),
      now = this.clock.now();
    const c = this.save<FeedbackComment>("comment", "feedback-comment", commentId, {
      commentId,
      sessionId: p.sessionId,
      author: { kind: "human" },
      channel,
      ...(anchor ? { anchor } : {}),
      body: p.body,
      ...(p.suggestion ? { suggestion: p.suggestion } : {}),
      threadId,
      ...(p.replyTo ? { replyTo: p.replyTo } : {}),
      state: "open",
      deleted: false,
      read: true,
      createdAt: now,
      updatedAt: now,
    });
    this.event("vc.CommentPosted", { kind: "comment", id: commentId }, { commentId, sessionId: p.sessionId, threadId });
    this.store.saveFeedback(
      "delivery-state",
      commentId,
      this.contract.read<Json>("delivery-state", {
        commentId,
        state: "saved",
        updatedAt: now,
      }),
    );
    const triggerRecord = this.store.feedback("thread-trigger", `${p.sessionId}:${threadId}`);
    const mode =
      triggerRecord === undefined
        ? session.replyTrigger
        : this.contract.read<ReplyTrigger>("reply-trigger", triggerRecord).mode;
    if (mode !== "manual") {
      const prefs = sessionPreferences(this.settings(), p.sessionId),
        batch =
          triggerRecord === undefined
            ? undefined
            : this.contract.read<ReplyTrigger>("reply-trigger", triggerRecord).batch;
      const delaySeconds =
        mode === "realtime"
          ? (prefs.realtimeDebounceSeconds ?? this.settings().budgets.realtimeDebounceSeconds ?? 8)
          : undefined;
      const quietMinutes = batch?.idleMinutes ?? prefs.batchIdleMinutes ?? 10,
        threshold = batch?.count ?? prefs.batchCommentThreshold ?? 5;
      const savedCount = this.store.feedbackList("delivery-state").filter((item) => {
        const state = this.contract.read<{
          commentId: string;
          state: string;
        }>("delivery-state", item);
        if (state.state !== "saved") return false;
        const target = this.store.feedback("comment", state.commentId);
        return (
          target !== undefined &&
          this.contract.read<FeedbackComment>("feedback-comment", target).sessionId === p.sessionId
        );
      }).length;
      const notBefore =
        mode === "realtime"
          ? Date.parse(now) + delaySeconds! * 1000
          : Date.parse(now) + (savedCount >= threshold ? 0 : quietMinutes * 60_000);
      this.store.enqueue(
        "agent.trigger",
        this.ids.next("trigger_"),
        this.contract.read<Json>("json", {
          sessionId: p.sessionId,
          mode,
          notBefore: new Date(notBefore).toISOString(),
        }),
        now,
      );
    }
    return { commentId: c.commentId, threadId };
  }
}
