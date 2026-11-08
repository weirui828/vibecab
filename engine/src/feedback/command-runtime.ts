import { fail } from "../../../contract/src/index.js";
import type {
  FeedbackComment,
  Json,
  Principal,
  CallContext,
  Idea,
  Project,
  Session,
  SessionArtifact,
  ReplyTrigger,
  VcCaptureIdeaOperation,
  VcEditIdeaOperation,
  VcMarkReadOperation,
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
  command(name: string, raw: unknown, principal: Principal, channel: CallContext["channel"]): unknown {
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
      case "vc.EditIdea": {
        const p = this.contract.read<VcEditIdeaOperation["payload"]>(
          "operations/vc.EditIdea",
          raw,
          "#/properties/payload",
        );
        // Only the words change: the idea keeps its id, links, date and the sessions and projects it went into.
        const idea = this.get<Idea>("idea", "idea", p.ideaId);
        this.save<Idea>("idea", "idea", p.ideaId, { ...idea, text: p.text });
        this.event("vc.IdeaEdited", { kind: "idea", id: p.ideaId }, { ideaId: p.ideaId });
        return { ideaId: p.ideaId };
      }
      case "vc.MarkRead": {
        const p = this.contract.read<VcMarkReadOperation["payload"]>(
          "operations/vc.MarkRead",
          raw,
          "#/properties/payload",
        );
        this.session(p.sessionId);
        const comments = p.commentIds.map((id) => this.comment(id));
        if (comments.some((c) => c.sessionId !== p.sessionId)) fail("not_found", "Comment not found in this session");
        // A reply is read once the person has looked at it (covibe's rule), not when the session is opened.
        const marked = comments
          .filter((c) => !c.read)
          .map((c) => {
            this.save<FeedbackComment>("comment", "feedback-comment", c.commentId, { ...c, read: true });
            return c.commentId;
          });
        if (marked.length)
          this.event(
            "vc.CommentsRead",
            { kind: "session", id: p.sessionId },
            { sessionId: p.sessionId, commentIds: marked },
          );
        return { commentIds: p.commentIds };
      }
      case "vc.CreateProject": {
        const p = this.contract.read<VcCreateProjectOperation["payload"]>(
          "operations/vc.CreateProject",
          raw,
          "#/properties/payload",
        );
        for (const ideaId of p.ideaIds ?? []) this.get<Idea>("idea", "idea", ideaId);
        for (const artifactId of p.artifactIds ?? []) this.store.artifact(artifactId);
        for (const sessionId of p.sessionIds ?? []) this.session(sessionId);
        for (const sessionId of p.sourceSessionIds ?? []) this.session(sessionId);
        const projectId = this.ids.next("project_");
        this.save<Project>("project", "project", projectId, {
          projectId,
          title: p.title,
          ...(p.background === undefined ? {} : { background: p.background }),
          ...(p.ideaIds?.length ? { ideaIds: [...new Set(p.ideaIds)] } : {}),
          ...(p.artifactIds?.length ? { artifactIds: [...new Set(p.artifactIds)] } : {}),
          ...(p.sessionIds?.length ? { sessionIds: [...new Set(p.sessionIds)] } : {}),
          ...(p.sourceSessionIds?.length ? { sourceSessionIds: [...new Set(p.sourceSessionIds)] } : {}),
          createdAt: this.clock.now(),
        });
        this.event("vc.ProjectCreated", { kind: "project", id: projectId }, { projectId });
        return { projectId };
      }
      case "vc.AttachProjectItem":
      case "vc.DetachProjectItem": {
        const p = this.contract.read<{
          projectId: string;
          item: { kind: "idea" | "artifact" | "session"; id: string };
        }>("operations/" + name, raw, "#/properties/payload");
        const project = this.get<Project>("project", "project", p.projectId),
          key = p.item.kind === "idea" ? "ideaIds" : p.item.kind === "artifact" ? "artifactIds" : "sessionIds";
        if (p.item.kind === "idea") this.get<Idea>("idea", "idea", p.item.id);
        else if (p.item.kind === "artifact") this.store.artifact(p.item.id);
        else this.session(p.item.id);
        const current = project[key] ?? [],
          attached = name === "vc.AttachProjectItem",
          values = attached ? [...new Set([...current, p.item.id])] : current.filter((id) => id !== p.item.id);
        if (!attached && values.length === current.length) fail("not_found", "Item is not attached to this Project");
        this.save<Project>("project", "project", p.projectId, { ...project, [key]: values });
        if (!attached && p.item.kind === "session") {
          const session = this.session(p.item.id);
          if (session.primaryProjectId === p.projectId) {
            const detached = { ...session };
            delete detached.primaryProjectId;
            this.save<Session>("session", "session", p.item.id, detached);
          }
        }
        const eventType = attached ? "vc.ProjectItemAttached" : "vc.ProjectItemDetached";
        this.event(
          eventType,
          { kind: "project", id: p.projectId },
          {
            projectId: p.projectId,
            kind: p.item.kind,
            id: p.item.id,
          },
        );
        return { projectId: p.projectId };
      }
      case "vc.StartSession": {
        const p = this.contract.read<VcStartSessionOperation["payload"]>(
          "operations/vc.StartSession",
          raw,
          "#/properties/payload",
        );
        if (p.primaryProjectId) this.get<Project>("project", "project", p.primaryProjectId);
        for (const ideaId of p.ideaIds ?? []) this.get<Idea>("idea", "idea", ideaId);
        const sessionId = this.ids.next("session_");
        this.save<Session>("session", "session", sessionId, {
          sessionId,
          title: p.title,
          ...(p.primaryProjectId ? { primaryProjectId: p.primaryProjectId } : {}),
          ...(p.ideaIds?.length ? { ideaIds: [...new Set(p.ideaIds)] } : {}),
          state: "active",
          replyTrigger: p.replyTrigger ?? this.settings().sessions.default?.replyTrigger ?? "manual",
          createdAt: this.clock.now(),
        });
        if (p.primaryProjectId) {
          const project = this.get<Project>("project", "project", p.primaryProjectId),
            sessionIds = [...new Set([...(project.sessionIds ?? []), sessionId])];
          this.save<Project>("project", "project", p.primaryProjectId, { ...project, sessionIds });
        }
        this.event("vc.SessionStarted", { kind: "session", id: sessionId }, { sessionId });
        return { sessionId };
      }
      case "vc.RenameSession": {
        const p = this.contract.read<{ sessionId: string; title: string }>(
            "operations/" + name,
            raw,
            "#/properties/payload",
          ),
          session = this.session(p.sessionId);
        this.save<Session>("session", "session", p.sessionId, { ...session, title: p.title });
        this.event("vc.SessionRenamed", { kind: "session", id: p.sessionId }, p);
        return p;
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
        return this.post(
          this.contract.read<FeedbackInput>("operations/vc.Comment", raw, "#/properties/payload"),
          channel,
        );
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
        if (session.state === "ended") fail("conflict", "Ended sessions are read-only");
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
        if (!p.threadId && p.batch)
          this.save<ReplyTrigger>("session-trigger", "reply-trigger", p.sessionId, { mode: p.mode, batch: p.batch });
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
      ...(parent.anchor ? { anchor: parent.anchor } : {}),
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
