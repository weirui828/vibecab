import { Button } from "@wei/design-system";
import type { Agreement, Update } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";
import { Dialog } from "../ui/Dialog.js";
import { relativeTime } from "../ui/time.js";
import type { Thread } from "./threads.js";

/** One applied change to a block: the Update that made it, and what was asked for. */
export interface HistoryEntry {
  key: string;
  version: number;
  when: string;
  asks: Array<{ key: string; text: string; how: string }>;
}

type SlotOf = (elementId: string) => string | undefined;

/** The changes an Update applied to a block (or to anything inside it: a list item's text, a table cell). */
const appliedTo = (update: Update, block: string, slotOf: SlotOf) =>
  update.resultVersion
    ? update.itemResults.filter(
        (r) => r.status === "addressed" && (r.elementIds ?? []).some((id) => id === block || slotOf(id) === block),
      )
    : [];

/** Blocks some Update has changed: only these have a change history to show. */
export function changedBlocks(updates: Update[], slotOf: SlotOf): Set<string> {
  const blocks = new Set<string>();
  for (const update of updates)
    if (update.resultVersion)
      for (const r of update.itemResults)
        if (r.status === "addressed")
          for (const id of r.elementIds ?? []) {
            const block = slotOf(id);
            if (block) blocks.add(block);
          }
  return blocks;
}

/**
 * A block's change history, oldest first: each Update that changed it, with the comments that asked for the change
 * and how each was agreed. Agreements not yet applied are not history and are left out. Exported for tests.
 */
export function historyEntries(
  block: string,
  updates: Update[],
  agreements: Agreement[],
  threads: Thread[],
  slotOf: SlotOf,
): HistoryEntry[] {
  // What was asked: the opening comment of the agreed comment's thread, else the instruction the engine kept.
  const asked = (a: Agreement) =>
    threads.find((t) => t.comments.some((c) => c.commentId === a.commentId))?.comments[0]?.body ?? a.instruction;
  const how = (a: Agreement) =>
    a.kind === "option" && a.optionLabel
      ? `You agreed to the agent's option “${a.optionLabel}”`
      : a.kind === "agent_proposal"
        ? "You agreed to the agent's proposal"
        : "You agreed to your comment";
  return updates
    .map((update) => ({ update, results: appliedTo(update, block, slotOf) }))
    .filter(({ results }) => results.length > 0)
    .map(({ update, results }) => ({
      key: update.updateId,
      version: update.resultVersion ?? 0,
      when: update.updatedAt ?? update.createdAt,
      asks: results.flatMap((r) => {
        const agreement = agreements.find((a) => a.agreementId === r.itemId);
        return agreement ? [{ key: r.itemId, text: asked(agreement), how: how(agreement) }] : [];
      }),
    }))
    .sort((a, b) => a.version - b.version);
}

export function ChangeHistory({ entries, open, onClose }: { entries: HistoryEntry[]; open: boolean; onClose(): void }) {
  return (
    <Dialog
      open={open}
      title="Change history"
      lede={`How this part changed, oldest first: each ${terms.update} and what asked for it.`}
      onClose={onClose}
      onSubmit={onClose}
      buttons={
        <Button type="submit" variant="ghost">
          Close
        </Button>
      }
    >
      <ol className="vc-why">
        {entries.map((e) => (
          <li key={e.key}>
            <span className="vc-facts">
              Version {e.version} · {relativeTime(e.when)}
            </span>
            {e.asks.length ? (
              e.asks.map((ask) => (
                <span key={ask.key} className="ask">
                  <span className="detail">“{ask.text}”</span>
                  <span className="how">{ask.how}</span>
                </span>
              ))
            ) : (
              <span className="how">Changed by an {terms.update}</span>
            )}
          </li>
        ))}
      </ol>
    </Dialog>
  );
}
