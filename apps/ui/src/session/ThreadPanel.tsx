import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  AgentTurn,
  ContextManifest,
  DeliveryState,
  VcThreadsOperation,
} from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";

type Thread = VcThreadsOperation["result"][number];

export function ThreadPanel({
  threads,
  turns,
  nextUpdateCommentIds = [],
  delivery,
  currentVersion,
  onRefresh,
  onReply,
  onAskAgent,
  onSetThreadTrigger,
  renderReply,
}: {
  threads: VcThreadsOperation["result"];
  turns: AgentTurn[];
  nextUpdateCommentIds?: string[];
  delivery: Record<string, DeliveryState["state"]>;
  currentVersion: number;
  onRefresh: () => Promise<void>;
  onReply: (commentId: string) => void;
  onAskAgent: (threadId: string) => void;
  onSetThreadTrigger: (threadId: string, mode: "realtime" | "batch" | "manual") => void;
  renderReply?: (commentId: string) => ReactNode;
}) {
  const [filter, setFilter] = useState("all");
  const filtered = useMemo(
    () =>
      threads.filter(
        (thread) =>
          filter === "all" ||
          (filter === "mine"
            ? thread.comments.some((comment) => comment.author.kind === "human")
            : thread.comments.some((comment) => comment.author.kind === "agent")),
      ),
    [threads, filter],
  );
  return (
    <aside className="threads-panel" aria-label="Threads">
      <div className="rail-head">
        <h2 className="eyebrow">Threads</h2>
        <label className="rail-filter">
          <span className="visually-hidden">Filter</span>
          Filter{" "}
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All</option>
            <option value="mine">Mine</option>
            <option value="agent">Agent</option>
          </select>
        </label>
      </div>
      {filtered.length === 0 ? (
        <p className="quiet rail-empty">
          Select text in the {terms.document.toLowerCase()} and comment on it. Threads appear here and beside the text
          they are about.
        </p>
      ) : null}
      {filtered.map((thread) => (
        <ThreadCard
          key={thread.threadId}
          thread={thread}
          turns={turns}
          nextUpdateCommentIds={nextUpdateCommentIds}
          delivery={delivery}
          currentVersion={currentVersion}
          onRefresh={onRefresh}
          onReply={onReply}
          onAskAgent={onAskAgent}
          onSetThreadTrigger={onSetThreadTrigger}
          renderReply={renderReply}
        />
      ))}
    </aside>
  );
}

/** One conversation. Rendered in the rail for general or detached threads, and inline in the
 *  Document directly under the block a thread is anchored to. */
export function ThreadCard({
  thread,
  turns,
  nextUpdateCommentIds = [],
  delivery,
  currentVersion,
  onRefresh,
  onReply,
  onAskAgent,
  onSetThreadTrigger,
  renderReply,
  inline = false,
}: {
  thread: Thread;
  turns: AgentTurn[];
  nextUpdateCommentIds?: string[];
  delivery: Record<string, DeliveryState["state"]>;
  currentVersion: number;
  onRefresh: () => Promise<void>;
  onReply: (commentId: string) => void;
  onAskAgent: (threadId: string) => void;
  onSetThreadTrigger: (threadId: string, mode: "realtime" | "batch" | "manual") => void;
  renderReply?: (commentId: string) => ReactNode;
  inline?: boolean;
}) {
  const [message, setMessage] = useState(""),
    [manifest, setManifest] = useState<ContextManifest[]>();
  const submit = async (type: string, payload: unknown) => {
    const result = await window.vibecab.command(type, payload);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setMessage("");
    await onRefresh();
  };
  const anchor = thread.comments.find((comment) => comment.anchor)?.anchor,
    quote = thread.comments.find((comment) => comment.anchor?.locator)?.anchor?.locator?.quote,
    removed = thread.anchorResolutions.some((resolution) => resolution.state === "removed"),
    revised = thread.anchorResolutions.some((resolution) => resolution.state === "revised");
  return (
    <article
      className={"thread-card" + (inline ? " inline-thread" : "")}
      data-anchor={removed ? "removed" : revised ? "revised" : anchor ? "current" : "general"}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const cards = Array.from(document.querySelectorAll<HTMLElement>(".thread-card"));
        const index = cards.indexOf(event.currentTarget);
        cards[Math.max(0, Math.min(cards.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }}
    >
      <header className="thread-head">
        {inline ? (
          <p className="inline-quote">{quote ? <q>{quote}</q> : anchor ? "On this block" : "On the whole session"}</p>
        ) : quote ? (
          <button
            className="thread-quote"
            onClick={() =>
              document
                .querySelector(`[data-element-id="${thread.comments[0]?.anchor?.elementId ?? ""}"]`)
                ?.scrollIntoView({ block: "center" })
            }
          >
            <span className="visually-hidden">Open thread</span>
            <q>{quote}</q>
          </button>
        ) : (
          <button
            className="thread-quote general"
            onClick={() =>
              document
                .querySelector(`[data-element-id="${thread.comments[0]?.anchor?.elementId ?? ""}"]`)
                ?.scrollIntoView({ block: "center" })
            }
          >
            {thread.comments[0]?.anchor ? "Open thread" : "On the whole session"}
          </button>
        )}
        <details className="thread-menu">
          <summary aria-label="Thread reply setting">⋯</summary>
          <div className="menu">
            <label>
              Reply trigger
              <select
                aria-label={`Reply trigger for thread ${thread.threadId}`}
                value={thread.replyTrigger?.mode ?? "session"}
                onChange={(event) => {
                  const mode = event.target.value;
                  if (mode === "realtime" || mode === "batch" || mode === "manual")
                    onSetThreadTrigger(thread.threadId, mode);
                }}
              >
                <option value="session">Use session setting</option>
                <option value="realtime">Realtime</option>
                <option value="batch">Batch</option>
                <option value="manual">Manual</option>
              </select>
            </label>
            <button type="button" onClick={() => onAskAgent(thread.threadId)}>
              Ask agent about this thread
            </button>
          </div>
        </details>
      </header>
      {removed ? <p className="anchor-note">This part was removed in v{currentVersion}.</p> : null}
      {revised ? <p className="anchor-note">Text changed since this comment.</p> : null}
      {thread.comments.map((comment) => {
        const turnId = comment.author.kind === "agent" ? comment.author.turnId : undefined,
          author = comment.author.kind === "human" ? "You" : comment.author.kind === "agent" ? "Agent" : "System",
          channel = comment.channel === "mcp" ? "via MCP" : comment.channel === "cli" ? "via CLI" : "",
          created = comment.createdAt ? relativeTime(comment.createdAt) : "",
          header = [author, channel, created].filter(Boolean).join(" · "),
          turn = turnId ? turns.find((item) => item.turnId === turnId) : undefined,
          deliveryText =
            comment.author.kind !== "human"
              ? ""
              : delivery[comment.commentId] === "queued" || delivery[comment.commentId] === "saved"
                ? "Waiting for agent"
                : delivery[comment.commentId] === "delivered"
                  ? "Agent is replying…"
                  : delivery[comment.commentId] === "replied"
                    ? "Replied"
                    : "",
          options = Array.isArray(comment.proposal) ? comment.proposal : undefined,
          single = comment.proposal && !Array.isArray(comment.proposal) ? comment.proposal : undefined,
          canAgree = ["open", "discussing"].includes(comment.state);
        return (
          <div
            key={comment.commentId}
            className={"comment " + (comment.author.kind === "system" ? "system-comment" : comment.author.kind)}
          >
            <p className="comment-meta">{header}</p>
            {comment.author.kind === "agent" && comment.proposal ? <p className="proposes">Agent proposes:</p> : null}
            <p className="comment-body">{comment.body}</p>
            {options ? (
              <ul className="options">
                {options.map((option) => (
                  <li key={option.label} className="option">
                    <p className="option-label">{option.label}</p>
                    <p className="option-text">{option.text}</p>
                    {comment.author.kind === "agent" && canAgree ? (
                      <button
                        type="button"
                        className="agree"
                        aria-label={`Agree with option: ${option.label}`}
                        onClick={() =>
                          void submit("vc.Agree", {
                            commentId: comment.commentId,
                            kind: "option",
                            optionLabel: option.label,
                          })
                        }
                      >
                        Agree
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {single ? (
              <div className="option">
                <p className="option-text">{single.text}</p>
                {comment.author.kind === "agent" && canAgree ? (
                  <button
                    type="button"
                    className="agree"
                    onClick={() => void submit("vc.Agree", { commentId: comment.commentId, kind: "agent_proposal" })}
                  >
                    Agree with agent&apos;s proposal
                  </button>
                ) : null}
              </div>
            ) : null}
            {comment.state === "applied" ? (
              <button
                type="button"
                className="state-pill applied"
                onClick={() => document.querySelector('[aria-label="Update diff"]')?.scrollIntoView({ block: "start" })}
              >
                Applied in v{comment.appliedInVersion ?? currentVersion}
              </button>
            ) : (
              <p className="state-line" data-state={comment.state}>
                {comment.state === "agreed"
                  ? nextUpdateCommentIds.includes(comment.commentId)
                    ? "Will go into the next Update"
                    : "Agreed — waiting for the next Update"
                  : comment.state === "scheduled"
                    ? "In an Update"
                    : terms[comment.state]}
                {deliveryText ? <span className="delivery"> · {deliveryText}</span> : null}
              </p>
            )}
            {turn?.status === "running" ? (
              <p role="status" className="agent-reading">
                Agent is reading…
              </p>
            ) : null}
            {turnId && ["failed", "uncertain"].includes(turn?.status ?? "") ? (
              <p className="anchor-note">
                Agent reply needs attention.{" "}
                <button type="button" onClick={() => onAskAgent(thread.threadId)}>
                  Retry
                </button>
              </p>
            ) : null}
            <div className="comment-actions">
              {comment.author.kind === "human" && canAgree ? (
                <>
                  <button
                    type="button"
                    className="agree"
                    onClick={() =>
                      void submit("vc.Agree", {
                        commentId: comment.commentId,
                        kind: "as_written",
                      })
                    }
                  >
                    {terms.acknowledge}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const reason = window.prompt("Why decline this comment? (optional)");
                      void submit("vc.Decline", {
                        commentId: comment.commentId,
                        ...(reason?.trim() ? { reason: reason.trim() } : {}),
                      });
                    }}
                  >
                    Decline
                  </button>
                </>
              ) : null}
              <button type="button" onClick={() => onReply(comment.commentId)}>
                Reply
              </button>
              {comment.author.kind === "human" ? (
                <>
                  <button
                    onClick={() => {
                      const updated = window.prompt("Edit comment", comment.body);
                      if (updated?.trim())
                        void window.vibecab
                          .command("vc.EditComment", { commentId: comment.commentId, body: updated })
                          .then(onRefresh);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm("Delete this comment?"))
                        void window.vibecab
                          .command("vc.DeleteComment", { commentId: comment.commentId })
                          .then(onRefresh);
                    }}
                  >
                    Delete
                  </button>
                </>
              ) : null}
              {turnId ? (
                <button
                  type="button"
                  onClick={() =>
                    void window.vibecab
                      .query<ContextManifest[]>("vc.Manifest", { turnId })
                      .then(setManifest)
                      .catch(() => setMessage("Could not load the agent's context manifest."))
                  }
                >
                  Why did the agent say this?
                </button>
              ) : null}
            </div>
            {renderReply?.(comment.commentId)}
          </div>
        );
      })}
      {message ? <p role="alert">{message}</p> : null}
      {manifest ? (
        <dialog open aria-label="Agent context manifest" className="manifest">
          {manifest.map((entry) => (
            <div key={entry.manifestId}>
              <h3>Context for agent reply</h3>
              <ul>
                {entry.items.map((item, index) => (
                  <li key={index}>
                    {item.kind}: {item.reason}
                  </li>
                ))}
              </ul>
              <h4>Not included</h4>
              <ul>
                {entry.dropped.map((item, index) => (
                  <li key={index}>
                    {item.kind}: {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <button type="button" onClick={() => setManifest(undefined)}>
            Close
          </button>
        </dialog>
      ) : null}
    </article>
  );
}

function relativeTime(timestamp: string): string {
  const seconds = (Date.parse(timestamp) - Date.now()) / 1_000,
    magnitude = Math.abs(seconds),
    [value, unit] =
      magnitude < 60
        ? [Math.round(seconds), "second"]
        : magnitude < 3_600
          ? [Math.round(seconds / 60), "minute"]
          : magnitude < 86_400
            ? [Math.round(seconds / 3_600), "hour"]
            : magnitude < 2_592_000
              ? [Math.round(seconds / 86_400), "day"]
              : [Math.round(seconds / 2_592_000), "month"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit as Intl.RelativeTimeFormatUnit);
}
