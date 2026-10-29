import type {
  Agreement,
  Anchor,
  AnchorResolution,
  FeedbackComment,
  FeedbackConflict,
  Idea,
  Project,
  ReplyTrigger,
  Session,
  SessionArtifact,
  Thread,
  Json,
  Principal,
  VcAgreeOperation,
  VcAttachArtifactOperation,
  VcCaptureIdeaOperation,
  VcCommentOperation,
  VcConflictsOperation,
  VcCreateProjectOperation,
  VcDecisionRecordOperation,
  VcDeclineOperation,
  VcDeleteCommentOperation,
  VcEditCommentOperation,
  VcFeedbackItemsOperation,
  VcResolveConflictOperation,
  VcSessionsOperation,
  VcSetReplyTriggerOperation,
  VcStartSessionOperation,
  VcThreadsOperation,
  Settings,
  OutputSet,
  Update,
  SessionSeen,
} from "../../../contract/src/index.js";
import { fail, type Contract } from "../../../contract/src/index.js";
import type { Clock, IdGenerator } from "../kernel/dependencies.js";
import type { Repository } from "../storage/repository.js";
import { resolveAnchors } from "../content/diff.js";

type FeedbackInput = VcCommentOperation["payload"];

export class Feedback {
  constructor(
    private readonly store: Repository,
    private readonly contract: Contract,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly settings: () => Settings,
  ) {}
  private save<T>(kind: string, schema: string, id: string, value: unknown): T {
    const checked = this.contract.read<T>(schema, value);
    this.store.saveFeedback(kind, id, this.contract.read<Json>("json", checked));
    return checked;
  }
  private get<T>(kind: string, schema: string, id: string): T {
    const value = this.store.feedback(kind, id);
    if (value === undefined) fail("not_found", "Feedback item not found");
    return this.contract.read<T>(schema, value);
  }
  private list<T>(kind: string, schema: string): T[] {
    return this.store.feedbackList(kind).map((value) => this.contract.read<T>(schema, value));
  }
  private session(id: string): Session {
    return this.get("session", "session", id);
  }
  private comment(id: string): FeedbackComment {
    return this.get("comment", "feedback-comment", id);
  }
  private agreement(id: string): Agreement {
    return this.get("agreement", "agreement", id);
  }
  private event(type: string, entity: { kind: string; id: string }, payload: unknown) {
    this.store.appendEvent({
      ts: this.clock.now(),
      type,
      entity,
      payload: this.contract.read<Json>("events/" + type, payload),
    });
  }
  command(name: string, raw: unknown, principal: Principal): unknown {
    if (principal.kind !== "human") fail("forbidden", "Feedback commands require a human principal");
    switch (name) {
      case "vc.CaptureIdea": {
        const p = this.contract.read<VcCaptureIdeaOperation["payload"]>(
          "operations/vc.CaptureIdea",
          raw,
          "#/properties/payload",
        );
        const ideaId = this.ids.next("idea_");
        this.save<Idea>("idea", "idea", ideaId, {
          ideaId,
          text: p.text,
          ...(p.links ? { links: p.links } : {}),
          createdAt: this.clock.now(),
        });
        this.event("vc.IdeaCaptured", { kind: "idea", id: ideaId }, { ideaId });
        return { ideaId };
      }
      case "vc.CreateProject": {
        const p = this.contract.read<VcCreateProjectOperation["payload"]>(
          "operations/vc.CreateProject",
          raw,
          "#/properties/payload",
        );
        const projectId = this.ids.next("project_");
        this.save<Project>("project", "project", projectId, {
          projectId,
          title: p.title,
          ...(p.background === undefined ? {} : { background: p.background }),
          createdAt: this.clock.now(),
        });
        this.event("vc.ProjectCreated", { kind: "project", id: projectId }, { projectId });
        return { projectId };
      }
      case "vc.StartSession": {
        const p = this.contract.read<VcStartSessionOperation["payload"]>(
          "operations/vc.StartSession",
          raw,
          "#/properties/payload",
        );
        if (p.primaryProjectId) this.get<Project>("project", "project", p.primaryProjectId);
        const sessionId = this.ids.next("session_");
        this.save<Session>("session", "session", sessionId, {
          sessionId,
          title: p.title,
          ...(p.primaryProjectId ? { primaryProjectId: p.primaryProjectId } : {}),
          state: "active",
          replyTrigger: p.replyTrigger ?? "manual",
          createdAt: this.clock.now(),
        });
        this.event("vc.SessionStarted", { kind: "session", id: sessionId }, { sessionId });
        return { sessionId };
      }
      case "vc.AttachArtifact": {
        const p = this.contract.read<VcAttachArtifactOperation["payload"]>(
          "operations/vc.AttachArtifact",
          raw,
          "#/properties/payload",
        );
        const session = this.session(p.sessionId);
        this.store.artifact(p.artifactId);
        if (session.state !== "active") fail("conflict", "Artifacts can only be attached to an active session");
        const key = `${p.sessionId}:${p.artifactId}`;
        if (
          p.role === "primary" &&
          this.list<SessionArtifact>("attachment", "session-artifact").some(
            (x) => x.sessionId === p.sessionId && x.role === "primary" && x.artifactId !== p.artifactId,
          )
        )
          fail("conflict", "Session already has a primary artifact");
        this.save<SessionArtifact>("attachment", "session-artifact", key, {
          sessionId: p.sessionId,
          artifactId: p.artifactId,
          role: p.role,
        });
        this.event(
          "vc.ArtifactAttached",
          { kind: "session", id: p.sessionId },
          { sessionId: p.sessionId, artifactId: p.artifactId, role: p.role },
        );
        return { sessionId: p.sessionId };
      }
      case "vc.PauseSession":
      case "vc.ResumeSession":
      case "vc.EndSession": {
        const p = this.contract.read<{ sessionId: string }>("operations/" + name, raw, "#/properties/payload"),
          session = this.session(p.sessionId);
        const next = name === "vc.PauseSession" ? "paused" : name === "vc.ResumeSession" ? "active" : "ended";
        if (
          (next === "paused" && session.state !== "active") ||
          (next === "active" && session.state !== "paused") ||
          (next === "ended" && session.state === "ended")
        )
          fail("conflict", "Invalid session state transition");
        this.save<Session>("session", "session", p.sessionId, {
          ...session,
          state: next,
        });
        this.event(
          "vc.SessionStateChanged",
          { kind: "session", id: p.sessionId },
          { sessionId: p.sessionId, state: next },
        );
        return { sessionId: p.sessionId, state: next };
      }
      case "vc.Comment":
        return this.post(this.contract.read<FeedbackInput>("operations/vc.Comment", raw, "#/properties/payload"));
      case "vc.EditComment": {
        const p = this.contract.read<VcEditCommentOperation["payload"]>(
          "operations/vc.EditComment",
          raw,
          "#/properties/payload",
        );
        const c = this.comment(p.commentId);
        this.editable(c);
        if (p.suggestion && !c.anchor?.locator?.quote) fail("invalid", "A suggestion requires a text quote anchor");
        const updated = {
          ...c,
          body: p.body,
          ...(p.suggestion ? { suggestion: p.suggestion } : {}),
          updatedAt: this.clock.now(),
        };
        this.save<FeedbackComment>("comment", "feedback-comment", c.commentId, updated);
        this.event(
          "vc.CommentEdited",
          { kind: "comment", id: c.commentId },
          { commentId: c.commentId, sessionId: c.sessionId },
        );
        return { commentId: c.commentId };
      }
      case "vc.DeleteComment": {
        const p = this.contract.read<VcDeleteCommentOperation["payload"]>(
            "operations/vc.DeleteComment",
            raw,
            "#/properties/payload",
          ),
          c = this.comment(p.commentId);
        this.editable(c);
        this.save<FeedbackComment>("comment", "feedback-comment", c.commentId, {
          ...c,
          deleted: true,
          updatedAt: this.clock.now(),
        });
        this.event(
          "vc.CommentDeleted",
          { kind: "comment", id: c.commentId },
          { commentId: c.commentId, sessionId: c.sessionId },
        );
        return { commentId: c.commentId, deleted: true };
      }
      case "vc.Agree":
        return this.agree(
          this.contract.read<VcAgreeOperation["payload"]>("operations/vc.Agree", raw, "#/properties/payload"),
        );
      case "vc.Decline": {
        const p = this.contract.read<VcDeclineOperation["payload"]>(
            "operations/vc.Decline",
            raw,
            "#/properties/payload",
          ),
          c = this.comment(p.commentId);
        this.editable(c);
        this.save<FeedbackComment>("comment", "feedback-comment", c.commentId, {
          ...c,
          state: "declined",
          ...(p.reason === undefined ? {} : { declineReason: p.reason }),
          updatedAt: this.clock.now(),
        });
        this.event(
          "vc.FeedbackStateChanged",
          { kind: "comment", id: c.commentId },
          { commentId: c.commentId, sessionId: c.sessionId, state: "declined" },
        );
        return { commentId: c.commentId, state: "declined" };
      }
      case "vc.ResolveConflict":
        return this.resolve(
          this.contract.read<VcResolveConflictOperation["payload"]>(
            "operations/vc.ResolveConflict",
            raw,
            "#/properties/payload",
          ),
        );
      case "vc.SetReplyTrigger": {
        const p = this.contract.read<VcSetReplyTriggerOperation["payload"]>(
            "operations/vc.SetReplyTrigger",
            raw,
            "#/properties/payload",
          ),
          session = this.session(p.sessionId);
        if (p.threadId) {
          const thread = this.list<FeedbackComment>("comment", "feedback-comment").find(
            (c) => c.sessionId === p.sessionId && c.threadId === p.threadId,
          );
          if (!thread) fail("not_found", "Thread not found");
        }
        if (p.threadId)
          this.save<ReplyTrigger>("thread-trigger", "reply-trigger", `${p.sessionId}:${p.threadId}`, {
            mode: p.mode,
            ...(p.batch === undefined ? {} : { batch: p.batch }),
          });
        else
          this.save<Session>("session", "session", p.sessionId, {
            ...session,
            replyTrigger: p.mode,
          });
        this.event(
          "vc.ReplyTriggerChanged",
          { kind: "session", id: p.sessionId },
          {
            sessionId: p.sessionId,
            ...(p.threadId ? { threadId: p.threadId } : {}),
            mode: p.mode,
          },
        );
        return { sessionId: p.sessionId };
      }
      case "vc.MarkHandled": {
        const p = this.contract.read<{ commentIds: string[] }>(
          "operations/vc.MarkHandled",
          raw,
          "#/properties/payload",
        );
        for (const commentId of p.commentIds) {
          const comment = this.comment(commentId);
          if (comment.author.kind !== "human") fail("invalid", "Only human comments can be marked handled");
          this.save("delivery-state", "delivery-state", commentId, {
            commentId,
            state: "handled",
            updatedAt: this.clock.now(),
          });
        }
        return { commentIds: p.commentIds };
      }
      default:
        fail("unsupported", "Operation is not supported");
    }
  }
  private editable(c: FeedbackComment) {
    if (c.deleted || !["open", "discussing"].includes(c.state))
      fail("conflict", "Feedback item can no longer be changed");
  }
  private post(p: FeedbackInput): { commentId: string; threadId: string } {
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
      if (p.anchor.locator && (!("text" in seenElement) || !seenElement.text.includes(p.anchor.locator.quote)))
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
      const prefs = this.settings().sessions[p.sessionId] ?? {},
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
  agentReply(input: {
    sessionId: string;
    threadId: string;
    turnId: string;
    body: string;
    replyTo?: string;
    proposal?: unknown;
  }): { commentId: string } {
    this.session(input.sessionId);
    const parent = this.list<FeedbackComment>("comment", "feedback-comment").find(
      (c) => c.sessionId === input.sessionId && c.threadId === input.threadId,
    );
    if (!parent) fail("not_found", "Thread not found");
    const commentId = this.ids.next("comment_"),
      now = this.clock.now();
    const comment = this.contract.read<FeedbackComment>("feedback-comment", {
      commentId,
      sessionId: input.sessionId,
      author: { kind: "agent", turnId: input.turnId },
      body: input.body,
      threadId: input.threadId,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.proposal === undefined ? {} : { proposal: input.proposal }),
      state: "open",
      deleted: false,
      read: false,
      createdAt: now,
      updatedAt: now,
    });
    this.store.saveFeedback("comment", commentId, this.contract.read<Json>("json", comment));
    this.event(
      "vc.CommentPosted",
      { kind: "comment", id: commentId },
      { commentId, sessionId: input.sessionId, threadId: input.threadId },
    );
    return { commentId };
  }
  systemNotice(sessionId: string, threadId: string, body: string): void {
    const commentId = this.ids.next("comment_"),
      now = this.clock.now();
    const notice = this.contract.read<FeedbackComment>("feedback-comment", {
      commentId,
      sessionId,
      author: { kind: "system" },
      body,
      threadId,
      state: "open",
      deleted: false,
      read: false,
      createdAt: now,
      updatedAt: now,
    });
    this.store.saveFeedback("comment", commentId, this.contract.read<Json>("json", notice));
    this.event("vc.CommentPosted", { kind: "comment", id: commentId }, { commentId, sessionId, threadId });
  }
  private agree(p: VcAgreeOperation["payload"]): {
    agreementId: string;
    commentId: string;
  } {
    const c = this.comment(p.commentId);
    this.editable(c);
    if (p.kind === "as_written" && p.instruction !== undefined)
      fail("invalid", "As-written agreements derive their instruction from the comment");
    if (p.kind === "agent_proposal" && c.author.kind !== "agent")
      fail("conflict", "Only an agent proposal can be agreed as an agent proposal");
    if (p.kind === "option" && !p.optionLabel) fail("invalid", "Option agreements require an optionLabel");
    if (p.kind !== "option" && p.optionLabel) fail("invalid", "optionLabel is only valid for option agreements");
    const instruction = p.instruction ?? (p.kind === "as_written" ? (c.suggestion?.replacement ?? c.body) : undefined);
    if (instruction === undefined) fail("invalid", "Agreement requires an instruction");
    const agreementId = this.ids.next("agreement_"),
      agreedAt = this.clock.now();
    this.save<Agreement>("agreement", "agreement", agreementId, {
      agreementId,
      commentId: c.commentId,
      instruction,
      kind: p.kind,
      ...(p.optionLabel ? { optionLabel: p.optionLabel } : {}),
      agreedBy: "human",
      agreedAt,
      state: "agreed",
    });
    this.save<FeedbackComment>("comment", "feedback-comment", c.commentId, {
      ...c,
      state: "agreed",
      updatedAt: agreedAt,
    });
    this.event(
      "vc.FeedbackStateChanged",
      { kind: "comment", id: c.commentId },
      { commentId: c.commentId, sessionId: c.sessionId, state: "agreed" },
    );
    this.detectConflicts(agreementId);
    if (c.anchor?.artifactId) {
      const settings = this.settings().sessions[c.sessionId],
        delay = settings?.updateIdleMinutes ?? 2;
      this.store.enqueue(
        "agent.update.trigger",
        this.ids.next("update_trigger_"),
        this.contract.read<Json>("json", {
          artifactId: c.anchor.artifactId,
          notBefore: new Date(Date.parse(agreedAt) + delay * 60_000).toISOString(),
        }),
        agreedAt,
      );
    }
    return { agreementId, commentId: c.commentId };
  }
  private detectsOverlap(a: FeedbackComment, b: FeedbackComment): boolean {
    const aa = a.anchor,
      bb = b.anchor;
    if (!aa || !bb) return false;
    if (aa.artifactId !== bb.artifactId) return false;
    const all = this.store.elements(aa.artifactId),
      parents = new Map(all.map((e) => [e.elementId, e.parentId]));
    const ancestor = (parent: string, child: string) => {
      let next = parents.get(child);
      while (next !== undefined && next !== null) {
        if (next === parent) return true;
        next = parents.get(next);
      }
      return false;
    };
    if (aa.elementId !== bb.elementId)
      return ancestor(aa.elementId, bb.elementId) || ancestor(bb.elementId, aa.elementId);
    if (a.suggestion && b.suggestion && aa.locator?.quote && bb.locator?.quote) {
      const element = all.find((e) => e.elementId === aa.elementId);
      if (element && "text" in element) {
        const unique = (quote: string) => {
          const start = element.text.indexOf(quote);
          return start >= 0 && element.text.indexOf(quote, start + 1) < 0 ? start : undefined;
        };
        const startA = unique(aa.locator.quote),
          startB = unique(bb.locator.quote);
        if (
          startA !== undefined &&
          startB !== undefined &&
          (startA + aa.locator.quote.length <= startB || startB + bb.locator.quote.length <= startA)
        )
          return false;
      }
    }
    return true;
  }
  private detectConflicts(agreementId: string) {
    const added = this.agreement(agreementId),
      current = this.comment(added.commentId);
    const existing = this.list<Agreement>("agreement", "agreement").filter(
      (a) => a.state === "agreed" && a.agreementId !== agreementId,
    );
    for (const other of existing) {
      const aComment = this.comment(other.commentId),
        bComment = current;
      if (!this.detectsOverlap(aComment, bComment)) continue;
      const itemIds = [other.agreementId, added.agreementId].sort();
      if (
        this.list<FeedbackConflict>("conflict", "feedback-conflict").some(
          (x) => x.itemIds.length === 2 && x.itemIds.every((id) => itemIds.includes(id)),
        )
      )
        continue;
      const conflictId = this.ids.next("conflict_");
      const conflict = this.save<FeedbackConflict>("conflict", "feedback-conflict", conflictId, {
        conflictId,
        itemIds,
        stage: "deterministic",
        state: "open",
        sessionId: current.sessionId,
        artifactId: current.anchor?.artifactId ?? aComment.anchor?.artifactId,
      });
      this.event("vc.ConflictDetected", { kind: "conflict", id: conflictId }, { conflictId, itemIds });
      for (const c of [aComment, bComment])
        this.postSystemNotice(c, conflict, c.commentId === aComment.commentId ? added : other);
    }
  }
  private postSystemNotice(target: FeedbackComment, conflict: FeedbackConflict, other: Agreement) {
    const duplicate = this.list<FeedbackComment>("comment", "feedback-comment").some(
      (c) => c.author.kind === "system" && c.threadId === target.threadId && c.body.includes(conflict.conflictId),
    );
    if (duplicate) return;
    const agreedComment = this.comment(other.commentId),
      commentId = this.ids.next("comment_"),
      now = this.clock.now();
    this.save<FeedbackComment>("comment", "feedback-comment", commentId, {
      commentId,
      sessionId: target.sessionId,
      author: { kind: "system" },
      body: `Conflict ${conflict.conflictId}: ${agreedComment.author.kind} agreed to item ${other.agreementId}.`,
      threadId: target.threadId,
      state: "open",
      deleted: false,
      read: false,
      createdAt: now,
      updatedAt: now,
    });
    this.event(
      "vc.CommentPosted",
      { kind: "comment", id: commentId },
      { commentId, sessionId: target.sessionId, threadId: target.threadId },
    );
  }
  private resolve(p: VcResolveConflictOperation["payload"]): {
    conflictId: string;
    state: "resolved";
  } {
    const keep = this.agreement(p.keep);
    if (keep.state !== "agreed") fail("conflict", "The kept agreement must still be active");
    const open = this.list<FeedbackConflict>("conflict", "feedback-conflict").filter((c) => c.state === "open");
    const related = new Set([p.keep]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of open)
        if (c.itemIds.some((id) => related.has(id)))
          for (const id of c.itemIds)
            if (!related.has(id)) {
              related.add(id);
              changed = true;
            }
    }
    const conflicts = open.filter((c) => c.itemIds.some((id) => related.has(id)));
    if (!conflicts.length) fail("not_found", "Open conflict not found");
    const expected = new Set(conflicts.flatMap((c) => c.itemIds.filter((id) => id !== p.keep)));
    if (p.supersede.length !== expected.size || p.supersede.some((id) => !expected.has(id)))
      fail("conflict", "ResolveConflict must supersede every other conflicting agreement");
    for (const id of p.supersede) {
      const agreement = this.agreement(id);
      if (agreement.state !== "agreed") fail("conflict", "Only active agreements can be superseded");
      this.save<Agreement>("agreement", "agreement", id, {
        ...agreement,
        state: "superseded",
        supersedes: [...(agreement.supersedes ?? []), keep.agreementId],
      });
      const c = this.comment(agreement.commentId);
      this.save<FeedbackComment>("comment", "feedback-comment", c.commentId, {
        ...c,
        state: "superseded",
        updatedAt: this.clock.now(),
      });
      this.event(
        "vc.FeedbackStateChanged",
        { kind: "comment", id: c.commentId },
        { commentId: c.commentId, sessionId: c.sessionId, state: "superseded" },
      );
    }
    for (const conflict of conflicts) {
      this.save<FeedbackConflict>("conflict", "feedback-conflict", conflict.conflictId, {
        ...conflict,
        state: "resolved",
      });
      this.event(
        "vc.ConflictResolved",
        { kind: "conflict", id: conflict.conflictId },
        {
          conflictId: conflict.conflictId,
          keep: p.keep,
          supersede: p.supersede,
        },
      );
    }
    return { conflictId: conflicts[0]!.conflictId, state: "resolved" };
  }
  query(name: string, raw: unknown): unknown {
    switch (name) {
      case "vc.Ideas":
        this.contract.read("operations/vc.Ideas", raw, "#/properties/payload");
        return this.list<Idea>("idea", "idea");
      case "vc.Projects":
        this.contract.read("operations/vc.Projects", raw, "#/properties/payload");
        return this.list<Project>("project", "project");
      case "vc.Sessions": {
        const p = this.contract.read<VcSessionsOperation["payload"]>(
          "operations/vc.Sessions",
          raw,
          "#/properties/payload",
        );
        const values = this.list<Session>("session", "session");
        return p.sessionId ? values.filter((s) => s.sessionId === p.sessionId) : values;
      }
      case "vc.Threads":
      case "vc.FeedbackItems": {
        const p =
          name === "vc.Threads"
            ? this.contract.read<VcThreadsOperation["payload"]>("operations/" + name, raw, "#/properties/payload")
            : this.contract.read<VcFeedbackItemsOperation["payload"]>(
                "operations/" + name,
                raw,
                "#/properties/payload",
              );
        const includeDeleted = name === "vc.Threads" && "includeDeleted" in p && p.includeDeleted === true;
        const comments = this.list<FeedbackComment>("comment", "feedback-comment").filter(
          (c) =>
            (!p.sessionId || c.sessionId === p.sessionId) &&
            (!p.state || c.state === p.state) &&
            (name !== "vc.Threads" || includeDeleted || !c.deleted) &&
            (!p.artifactId || c.anchor?.artifactId === p.artifactId),
        );
        if (name === "vc.FeedbackItems") return comments;
        const groups = new Map<string, FeedbackComment[]>();
        for (const c of comments) {
          const group = groups.get(c.threadId) ?? [];
          group.push(c);
          groups.set(c.threadId, group);
        }
        return [...groups].map(([threadId, threadComments]) => {
          const anchors = threadComments.flatMap((c) => (c.anchor ? [c.anchor] : []));
          const anchorResolutions: AnchorResolution[] = anchors.length ? resolveAnchors(this.store, anchors) : [];
          const trigger = this.store.feedback("thread-trigger", `${threadComments[0]!.sessionId}:${threadId}`);
          const replyTrigger =
            trigger === undefined ? undefined : this.contract.read<ReplyTrigger>("reply-trigger", trigger);
          const thread = {
            threadId,
            sessionId: threadComments[0]!.sessionId,
            comments: threadComments,
            anchorResolutions,
            ...(replyTrigger ? { replyTrigger } : {}),
          };
          return this.contract.read<Thread>("thread", thread);
        });
      }
      case "vc.DecisionRecord": {
        const p = this.contract.read<VcDecisionRecordOperation["payload"]>(
          "operations/vc.DecisionRecord",
          raw,
          "#/properties/payload",
        );
        return this.list<Agreement>("agreement", "agreement").filter((a) => {
          const c = this.comment(a.commentId);
          return c.anchor?.artifactId === p.artifactId && (!p.elementId || c.anchor.elementId === p.elementId);
        });
      }
      case "vc.Conflicts": {
        const p = this.contract.read<VcConflictsOperation["payload"]>(
          "operations/vc.Conflicts",
          raw,
          "#/properties/payload",
        );
        return this.list<FeedbackConflict>("conflict", "feedback-conflict").filter(
          (c) =>
            c.state === "open" &&
            (!p.sessionId || c.sessionId === p.sessionId) &&
            (!p.artifactId || c.artifactId === p.artifactId),
        );
      }
      case "vc.AttentionInbox": {
        this.contract.read("operations/vc.AttentionInbox", raw, "#/properties/payload");
        const conflicts = this.list<FeedbackConflict>("conflict", "feedback-conflict")
          .filter((c) => c.state === "open")
          .map((c) => ({
            kind: "conflict",
            id: c.conflictId,
            ...(c.sessionId ? { sessionId: c.sessionId } : {}),
            ...(c.artifactId ? { artifactId: c.artifactId } : {}),
          }));
        const agreements = this.list<Agreement>("agreement", "agreement")
          .filter((a) => a.state === "agreed")
          .map((a) => {
            const c = this.comment(a.commentId);
            return {
              kind: "agreed_item",
              id: a.agreementId,
              sessionId: c.sessionId,
              ...(c.anchor ? { artifactId: c.anchor.artifactId } : {}),
            };
          });
        const replies = this.list<FeedbackComment>("comment", "feedback-comment")
          .filter((c) => c.author.kind === "agent" && !c.read)
          .map((c) => ({
            kind: "unread_reply",
            id: c.commentId,
            sessionId: c.sessionId,
            ...(c.anchor ? { artifactId: c.anchor.artifactId } : {}),
          }));
        const proposals = this.list<FeedbackComment>("comment", "feedback-comment")
            .filter(
              (comment) =>
                comment.author.kind === "agent" &&
                comment.proposal !== undefined &&
                ["open", "discussing"].includes(comment.state),
            )
            .map((comment) => ({
              kind: "proposal",
              id: comment.commentId,
              sessionId: comment.sessionId,
              ...(comment.anchor ? { artifactId: comment.anchor.artifactId } : {}),
            })),
          outputSets = this.list<OutputSet>("output-set", "output-set").map((set) => ({
            kind: "output_set",
            id: set.outputSetId,
            ...(set.sessionId ? { sessionId: set.sessionId } : {}),
          })),
          updates = this.list<Update>("update", "update")
            .filter((update) =>
              [
                "queued",
                "planning",
                "awaiting_plan_review",
                "writing",
                "checking",
                "failed",
                "partially_committed",
              ].includes(update.status),
            )
            .map((update) => ({
              kind: ["failed", "partially_committed"].includes(update.status) ? "failed_update" : "running_update",
              id: update.updateId,
              artifactId: update.artifactId,
            })),
          newVersions = this.list<SessionSeen>("session-seen", "session-seen").flatMap((seen) => {
            const attached = this.list<SessionArtifact>("attachment", "session-artifact")
              .filter((link) => link.sessionId === seen.sessionId)
              .map((link) => link.artifactId);
            return this.store
              .eventsAfter(seen.lastSeenSeq)
              .filter(
                (event) =>
                  event.type === "vc.VersionCommitted" &&
                  event.entity.kind === "artifact" &&
                  attached.includes(event.entity.id),
              )
              .map((event) => {
                const payload = this.contract.read<{ artifactId: string; version: number }>(
                  "events/vc.VersionCommitted",
                  event.payload,
                );
                return {
                  kind: "new_version",
                  id: `${payload.artifactId}:${payload.version}`,
                  sessionId: seen.sessionId,
                  artifactId: payload.artifactId,
                };
              });
          });
        return [...conflicts, ...agreements, ...replies, ...proposals, ...newVersions, ...updates, ...outputSets];
      }
      default:
        fail("unsupported", "Operation is not supported");
    }
  }
}
