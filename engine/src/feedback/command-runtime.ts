import { fail } from "../../../contract/src/index.js";
import type {
  FeedbackComment,
  Json,
  Principal,
  Idea,
  Project,
  Session,
  SessionArtifact,
  ReplyTrigger,
  VcCaptureIdeaOperation,
  VcCreateProjectOperation,
  VcStartSessionOperation,
  VcAttachArtifactOperation,
  VcEditCommentOperation,
  VcDeleteCommentOperation,
  VcDeclineOperation,
  VcSetReplyTriggerOperation,
  VcAgreeOperation,
  VcResolveConflictOperation,
} from "../../../contract/src/index.js";
import { FeedbackCoreRuntime, type FeedbackInput } from "./core-runtime.js";
export abstract class FeedbackCommandRuntime extends FeedbackCoreRuntime {
  protected abstract agree(payload: VcAgreeOperation["payload"]): { agreementId: string; commentId: string };
  protected abstract resolve(payload: VcResolveConflictOperation["payload"]): { conflictId: string; state: "resolved" };
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
}
