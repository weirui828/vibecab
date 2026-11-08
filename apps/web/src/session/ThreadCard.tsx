import { forwardRef, useState } from "react";
import type { CSSProperties } from "react";
import { Button } from "@wei/design-system";
import { terms } from "../../../ui/src/copy/terms.js";
import type { FeedbackComment, Thread } from "./threads.js";
import {
  anchorOf,
  authorLabel,
  deliveryLabel,
  resolutionOf,
  stateLabel,
  threadState,
  unreadReplies,
  visibleComments,
} from "./threads.js";
import type { Delivery, TurnStatus } from "./threads.js";
import type { ThreadStatus } from "./loop.js";
import { Composer } from "./Composer.js";
import type { useCommentActions } from "./useCommentActions.js";
import { Menu } from "../ui/Menu.js";
import { relativeTime } from "../ui/time.js";

type Actions = ReturnType<typeof useCommentActions>;

export interface Decision {
  status: ThreadStatus | undefined;
  /** Nothing agreed or declined yet, and the person may decide here. */
  canDecide: boolean;
  manual: boolean;
  modelReady: boolean;
  onOpenChanges(version: number): void;
}

/**
 * The agent's proposal. Its words stay text with an "Agent proposes" label; the buttons say only "Agree", and their
 * accessible names quote the option label so a reader knows what they agree to.
 */
function Proposal({ comment, decide, actions }: { comment: FeedbackComment; decide: boolean; actions: Actions }) {
  const proposal = comment.proposal;
  if (!proposal) return null;
  const options = Array.isArray(proposal) ? proposal : undefined;
  return (
    <div className="vc-proposal">
      <p className="vc-label">Agent proposes</p>
      <ul>
        {(options ?? [{ label: "", text: proposal && !Array.isArray(proposal) ? proposal.text : "" }]).map(
          (item, index) => (
            <li key={index}>
              <span className="text">
                {item.label && <strong>{item.label}: </strong>}
                <span>{item.text}</span>
              </span>
              {decide && (
                <button
                  type="button"
                  className="vc-agree-option"
                  aria-label={
                    options ? `${terms.agree} with option: ${item.label}` : `${terms.agree} with the agent's proposal`
                  }
                  onClick={() =>
                    void actions.agree(
                      comment.commentId,
                      options ? { kind: "option", optionLabel: item.label } : { kind: "agent_proposal" },
                    )
                  }
                >
                  {terms.agree}
                </button>
              )}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function CommentItem({
  comment,
  actions,
  readOnly,
  decide,
}: {
  comment: FeedbackComment;
  actions: Actions;
  readOnly: boolean;
  decide: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [confirming, setConfirming] = useState(false);
  const own = comment.author.kind === "human" && !readOnly;
  return (
    <li className="vc-comment" data-author={comment.author.kind}>
      <div className="meta">
        <span className="who">{authorLabel(comment)}</span>
        <span className="vc-facts">{relativeTime(comment.createdAt)}</span>
        {own && !editing && (
          <span className="menu">
            <Menu
              label="Comment actions"
              items={[
                { label: "Edit", onSelect: () => setEditing(true) },
                { label: "Delete", tone: "danger", onSelect: () => setConfirming(true) },
              ]}
            />
          </span>
        )}
      </div>
      {editing ? (
        <Composer
          label="Edit comment"
          submitLabel="Save"
          initial={{
            body: comment.body,
            ...(comment.suggestion ? { replacement: comment.suggestion.replacement } : {}),
          }}
          allowSuggestion={comment.anchor?.locator !== undefined}
          onCancel={() => setEditing(false)}
          onSubmit={async ({ body, replacement }) => {
            const ok = await actions.edit(comment.commentId, body, replacement);
            if (ok) setEditing(false);
            return ok;
          }}
        />
      ) : (
        <>
          <p className="body">{comment.body}</p>
          {comment.suggestion && (
            <p className="vc-replace">
              <span className="vc-label">Replace with</span>
              <span>{comment.suggestion.replacement}</span>
            </p>
          )}
          <Proposal comment={comment} decide={decide && comment.author.kind === "agent"} actions={actions} />
        </>
      )}
      {confirming && (
        <div className="vc-confirm" role="alert">
          <span>Delete this comment?</span>
          <button type="button" className="danger" onClick={() => void actions.remove(comment.commentId)}>
            Delete
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

/** Agree / Decline for the opening comment. Never focused automatically; Decline asks for an optional reason. */
function DecideRow({ comment, actions }: { comment: FeedbackComment; actions: Actions }) {
  const [declining, setDeclining] = useState(false),
    [reason, setReason] = useState("");
  if (declining)
    return (
      <form
        className="vc-decline"
        aria-label="Decline"
        onSubmit={(event) => {
          event.preventDefault();
          void actions.decline(comment.commentId, reason.trim() || undefined);
        }}
      >
        <input
          aria-label="Why not? (optional)"
          placeholder="Why not? (optional)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button type="button" size="sm" variant="ghost" onClick={() => setDeclining(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="secondary">
          {terms.decline}
        </Button>
      </form>
    );
  return (
    <div className="vc-decide">
      <Button size="sm" variant="primary" onClick={() => void actions.agree(comment.commentId, { kind: "as_written" })}>
        {terms.agree}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setDeclining(true)}>
        {terms.decline}
      </Button>
    </div>
  );
}

export const ThreadCard = forwardRef<
  HTMLElement,
  {
    thread: Thread;
    focused: boolean;
    delivery: Delivery | undefined;
    turn: TurnStatus | undefined;
    readOnly: boolean;
    actions: Actions;
    decision: Decision;
    style?: CSSProperties;
    onActivate(): void;
  }
>(function ThreadCard({ thread, focused, delivery, turn, readOnly, actions, decision, style, onActivate }, ref) {
  const [replying, setReplying] = useState(false);
  const anchor = anchorOf(thread),
    resolution = resolutionOf(thread),
    comments = visibleComments(thread),
    opening = comments[0],
    last = comments.at(-1),
    state = threadState(thread),
    unread = unreadReplies(thread).length;
  const decide = decision.canDecide && !readOnly;
  const where = !anchor
    ? "On the whole session"
    : resolution?.state === "removed"
      ? "This part was removed"
      : resolution?.state === "revised"
        ? "Text changed since this comment"
        : anchor.locator
          ? undefined
          : "On this block";
  const agentLine = deliveryLabel(delivery, turn),
    failed = turn === "failed" || turn === "uncertain",
    waitingOnAgent = !decision.status && last?.author.kind === "human" && delivery !== "replied",
    askable =
      decision.modelReady && !readOnly && (failed || (decision.manual && waitingOnAgent && delivery !== "delivered"));
  const status = decision.status;
  return (
    <article
      ref={ref}
      className="vc-thread"
      data-thread-id={thread.threadId}
      data-focused={focused || undefined}
      data-resolution={resolution?.state}
      data-status={status?.tone}
      data-unread={unread > 0 || undefined}
      tabIndex={0}
      aria-label={`Thread: ${opening?.body.slice(0, 60) ?? ""}`}
      style={style}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, textarea, input, a, form")) return;
        onActivate();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" && !readOnly) {
          event.preventDefault();
          setReplying(true);
        }
      }}
    >
      {unread > 0 && (
        <p className="vc-new-tag">{unread === 1 ? "New reply" : `${unread} new replies`} · click to mark read</p>
      )}
      {anchor?.locator && <blockquote className="quote">{anchor.locator.quote}</blockquote>}
      {where && <p className="where">{where}</p>}
      <ul className="comments">
        {comments.map((comment) => (
          <CommentItem
            key={comment.commentId}
            comment={comment}
            actions={actions}
            readOnly={readOnly}
            decide={decide}
          />
        ))}
      </ul>
      {status && (
        <p className="vc-status" data-tone={status.tone}>
          {status.appliedIn ? (
            <button type="button" className="vc-link-button" onClick={() => decision.onOpenChanges(status.appliedIn!)}>
              {status.text}
            </button>
          ) : (
            status.text
          )}
        </p>
      )}
      {decide && opening?.author.kind === "human" && !replying && <DecideRow comment={opening} actions={actions} />}
      {replying ? (
        <Composer
          label="Reply"
          submitLabel="Reply"
          allowSuggestion={false}
          onCancel={() => setReplying(false)}
          onSubmit={async ({ body }) => {
            const ok = last ? await actions.reply(last.commentId, body) : false;
            if (ok) setReplying(false);
            return ok;
          }}
        />
      ) : (
        <div className="foot">
          {!status && state !== "open" && <span className="status">{stateLabel(state)}</span>}
          {agentLine && <span className="status">{agentLine}</span>}
          {askable && (
            <button type="button" className="vc-link-button" onClick={() => void actions.ask([thread.threadId])}>
              {failed ? "Try again" : "Ask agent"}
            </button>
          )}
          {!readOnly && (
            <button type="button" className="vc-link-button reply" onClick={() => setReplying(true)}>
              Reply
            </button>
          )}
        </div>
      )}
    </article>
  );
});
