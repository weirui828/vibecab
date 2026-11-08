import { forwardRef, useState } from "react";
import type { FeedbackComment, Thread } from "./threads.js";
import {
  anchorOf,
  authorLabel,
  deliveryLabel,
  resolutionOf,
  stateLabel,
  threadState,
  visibleComments,
} from "./threads.js";
import type { Delivery, TurnStatus } from "./threads.js";
import { Composer } from "./Composer.js";
import type { useCommentActions } from "./useCommentActions.js";
import { Menu } from "../ui/Menu.js";
import { relativeTime } from "../ui/time.js";

type Actions = ReturnType<typeof useCommentActions>;

function Proposal({ comment }: { comment: FeedbackComment }) {
  const proposal = comment.proposal;
  if (!proposal) return null;
  // Read-only until W4: the agent's words never become a button label.
  const items = Array.isArray(proposal) ? proposal : [{ label: "", text: proposal.text }];
  return (
    <div className="vc-proposal">
      <p className="vc-label">Agent proposes</p>
      <ul>
        {items.map((item, index) => (
          <li key={index}>
            {item.label && <strong>{item.label}: </strong>}
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Comment({ comment, actions, readOnly }: { comment: FeedbackComment; actions: Actions; readOnly: boolean }) {
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
          <Proposal comment={comment} />
        </>
      )}
      {confirming && (
        <div className="vc-confirm" role="alert">
          <span>Delete this comment?</span>
          <button type="button" className="danger" onClick={() => void actions.remove(comment.commentId)}>
            Delete
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </div>
      )}
    </li>
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
    style?: React.CSSProperties;
    onActivate(): void;
  }
>(function ThreadCard({ thread, focused, delivery, turn, readOnly, actions, style, onActivate }, ref) {
  const [replying, setReplying] = useState(false);
  const anchor = anchorOf(thread),
    resolution = resolutionOf(thread),
    comments = visibleComments(thread),
    state = threadState(thread),
    last = comments.at(-1);
  const where = !anchor
    ? "On the whole session"
    : resolution?.state === "removed"
      ? "This part was removed"
      : resolution?.state === "revised"
        ? "Text changed since this comment"
        : anchor.locator
          ? undefined
          : "On this block";
  const status = [state !== "open" ? stateLabel(state) : undefined, deliveryLabel(delivery, turn)].filter(Boolean);
  return (
    <article
      ref={ref}
      className="vc-thread"
      data-thread-id={thread.threadId}
      data-focused={focused || undefined}
      data-resolution={resolution?.state}
      tabIndex={0}
      aria-label={`Thread: ${comments[0]?.body.slice(0, 60) ?? ""}`}
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
      {anchor?.locator && <blockquote className="quote">{anchor.locator.quote}</blockquote>}
      {where && <p className="where">{where}</p>}
      <ul className="comments">
        {comments.map((comment) => (
          <Comment key={comment.commentId} comment={comment} actions={actions} readOnly={readOnly} />
        ))}
      </ul>
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
          {status.length > 0 && <span className="status">{status.join(" · ")}</span>}
          {!readOnly && (
            <button type="button" className="vc-link-button" onClick={() => setReplying(true)}>
              Reply
            </button>
          )}
        </div>
      )}
    </article>
  );
});
