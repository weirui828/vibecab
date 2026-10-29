import { fail } from "../../../contract/src/index.js";
import type {
  Agreement,
  AnchorResolution,
  FeedbackComment,
  FeedbackConflict,
  Idea,
  Project,
  ReplyTrigger,
  Session,
  SessionArtifact,
  Thread,
  VcSessionsOperation,
  VcThreadsOperation,
  VcFeedbackItemsOperation,
  VcDecisionRecordOperation,
  VcConflictsOperation,
  OutputSet,
  Update,
  SessionSeen,
} from "../../../contract/src/index.js";
import { resolveAnchors } from "../content/diff.js";
import { FeedbackAgreementRuntime } from "./agreement-runtime.js";
export class Feedback extends FeedbackAgreementRuntime {
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
