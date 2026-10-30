import { useMemo, useState } from "react";
import type { DeliveryState, VcThreadsOperation } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";

export function ThreadPanel({
  threads,
  delivery,
  currentVersion,
  onRefresh,
  onReply,
}: {
  threads: VcThreadsOperation["result"];
  delivery: Record<string, DeliveryState["state"]>;
  currentVersion: number;
  onRefresh: () => Promise<void>;
  onReply: (commentId: string) => void;
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
          {thread.comments.map((comment) => (
            <div key={comment.commentId}>
              <p>
                {comment.author.kind === "human" ? "You" : comment.author.kind === "agent" ? "Agent" : "System"} ·{" "}
                {comment.channel === "mcp" ? "via MCP" : comment.channel === "cli" ? "via CLI" : ""}
                {comment.createdAt ? ` · ${new Date(comment.createdAt).toLocaleString()}` : ""}
              </p>
              <p>{comment.body}</p>
              <p>{terms[comment.state]}</p>
              {comment.anchor?.locator ? <blockquote>{comment.anchor.locator.quote}</blockquote> : null}
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
              <button onClick={() => onReply(comment.commentId)}>Reply</button>
            </div>
          ))}
        </article>
      ))}
    </aside>
  );
}
