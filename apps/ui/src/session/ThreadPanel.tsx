import { useMemo, useState } from "react";
import type {
  AgentTurn,
  ContextManifest,
  DeliveryState,
  VcThreadsOperation,
} from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";

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
}) {
  const [filter, setFilter] = useState("all"),
    [instructions, setInstructions] = useState<Record<string, string>>({}),
    [message, setMessage] = useState(""),
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
      <h2>Threads</h2>
      <label>
        Filter{" "}
        <select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All</option>
          <option value="mine">Mine</option>
          <option value="agent">Agent</option>
        </select>
      </label>
      {filtered.map((thread) => (
        <article
          key={thread.threadId}
          className="thread-card"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const cards = Array.from(document.querySelectorAll<HTMLElement>(".thread-card"));
            const index = cards.indexOf(event.currentTarget);
            cards[Math.max(0, Math.min(cards.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
          }}
        >
          <details>
            <summary>Thread reply setting</summary>
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
          </details>
          <button
            onClick={() =>
              document
                .querySelector(`[data-element-id="${thread.comments[0].anchor?.elementId ?? ""}"]`)
                ?.scrollIntoView({ block: "center" })
            }
          >
            Open thread
          </button>
          {thread.anchorResolutions.some((resolution) => resolution.state === "removed") ? (
            <p>This part was removed in v{currentVersion}.</p>
          ) : null}
          {thread.anchorResolutions.some((resolution) => resolution.state === "revised") ? (
            <p>Text changed since this comment.</p>
          ) : null}
          {thread.comments.map((comment) => {
            const turnId = comment.author.kind === "agent" ? comment.author.turnId : undefined,
              author = comment.author.kind === "human" ? "You" : comment.author.kind === "agent" ? "Agent" : "System",
              channel = comment.channel === "mcp" ? "via MCP" : comment.channel === "cli" ? "via CLI" : "",
              created = comment.createdAt ? relativeTime(comment.createdAt) : "",
              header = [author, channel, created].filter(Boolean).join(" · ");
            return (
              <div key={comment.commentId} className={comment.author.kind === "system" ? "system-comment" : undefined}>
                <p className="comment-meta">{header}</p>
                {comment.author.kind === "agent" && comment.proposal ? <p>Agent proposes:</p> : null}
                <p>{comment.body}</p>
                {comment.state === "applied" ? (
                  <button
                    type="button"
                    onClick={() =>
                      document.querySelector('[aria-label="Update diff"]')?.scrollIntoView({ block: "start" })
                    }
                  >
                    Applied in v{comment.appliedInVersion ?? currentVersion}
                  </button>
                ) : (
                  <p>
                    {comment.state === "agreed"
                      ? nextUpdateCommentIds.includes(comment.commentId)
                        ? "Will go into the next Update"
                        : "Agreed — waiting for the next Update"
                      : comment.state === "scheduled"
                        ? "In an Update"
                        : terms[comment.state]}
                  </p>
                )}
                {comment.anchor?.locator ? <blockquote>{comment.anchor.locator.quote}</blockquote> : null}
                {comment.author.kind === "human" && ["open", "discussing"].includes(comment.state) ? (
                  <>
                    <label>
                      How to apply this
                      <textarea
                        aria-label="How to apply this"
                        value={instructions[comment.commentId] ?? ""}
                        onChange={(event) =>
                          setInstructions((current) => ({ ...current, [comment.commentId]: event.target.value }))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        void submit("vc.Agree", {
                          commentId: comment.commentId,
                          kind: "as_written",
                          ...(instructions[comment.commentId]?.trim()
                            ? { instruction: instructions[comment.commentId]!.trim() }
                            : {}),
                        })
                      }
                    >
                      Agree as written
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
                {comment.author.kind === "agent" && ["open", "discussing"].includes(comment.state) ? (
                  comment.proposal && Array.isArray(comment.proposal) ? (
                    comment.proposal.map((option) => (
                      <button
                        type="button"
                        key={option.label}
                        onClick={() =>
                          void submit("vc.Agree", {
                            commentId: comment.commentId,
                            kind: "option",
                            optionLabel: option.label,
                          })
                        }
                      >
                        Agree with option: {option.label}
                      </button>
                    ))
                  ) : comment.proposal ? (
                    <button
                      type="button"
                      onClick={() => void submit("vc.Agree", { commentId: comment.commentId, kind: "agent_proposal" })}
                    >
                      Agree with agent&apos;s proposal
                    </button>
                  ) : null
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
                {turnId && turns.find((turn) => turn.turnId === turnId)?.status === "running" ? (
                  <p role="status">Agent is reading…</p>
                ) : null}
                {turnId &&
                ["failed", "uncertain"].includes(turns.find((turn) => turn.turnId === turnId)?.status ?? "") ? (
                  <p>
                    Agent reply needs attention.{" "}
                    <button type="button" onClick={() => onAskAgent(thread.threadId)}>
                      Retry
                    </button>
                  </p>
                ) : null}
                {comment.author.kind === "human" ? (
                  <p>
                    {delivery[comment.commentId] === "queued" || delivery[comment.commentId] === "saved"
                      ? "Waiting for agent"
                      : delivery[comment.commentId] === "delivered"
                        ? "Agent is replying…"
                        : delivery[comment.commentId] === "replied"
                          ? "Replied"
                          : ""}
                  </p>
                ) : null}
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
                <button type="button" onClick={() => onReply(comment.commentId)}>
                  Reply
                </button>
              </div>
            );
          })}
        </article>
      ))}
      {message ? <p role="alert">{message}</p> : null}
      {manifest ? (
        <dialog open aria-label="Agent context manifest">
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
    </aside>
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
