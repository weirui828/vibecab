import { Button } from "@wei/design-system";
import type { Agreement } from "../../../../contract/generated/index.js";
import { terms } from "../../../ui/src/copy/terms.js";
import { useLiveQuery } from "../live/LiveStore.js";
import { Dialog } from "../ui/Dialog.js";
import { relativeTime } from "../ui/time.js";
import type { Loop } from "./loop.js";
import type { Thread } from "./threads.js";

export interface WhyEntry {
  key: string;
  when: string;
  text: string;
  detail?: string;
}

/**
 * The decision record of one block, oldest first: each agreed change about it (what was asked, how it was agreed)
 * and each Update that changed it. Exported for tests.
 */
export function whyEntries(agreements: Agreement[], threads: Thread[], loop: Loop, elementId: string): WhyEntry[] {
  // What was asked: the opening comment of the thread the agreed comment belongs to.
  const asked = (id: string) => threads.find((t) => t.comments.some((c) => c.commentId === id))?.comments[0];
  const entries: WhyEntry[] = agreements.map((a) => {
    const c = asked(a.commentId),
      how =
        a.kind === "option" && a.optionLabel
          ? `You agreed to the agent's option “${a.optionLabel}”`
          : a.kind === "agent_proposal"
            ? "You agreed to the agent's proposal"
            : "You agreed to your comment as written";
    return {
      key: a.agreementId,
      when: a.agreedAt ?? "",
      text: how,
      ...(c ? { detail: c.body } : {}),
    };
  });
  for (const update of loop.updates)
    for (const result of update.itemResults)
      if (result.status === "addressed" && result.elementIds?.includes(elementId) && update.resultVersion)
        entries.push({
          key: update.updateId + result.itemId,
          when: update.updatedAt ?? update.createdAt,
          text: `Changed by an ${terms.update} in version ${update.resultVersion}`,
        });
  return entries.sort((a, b) => a.when.localeCompare(b.when));
}

export function WhyDialog({
  artifactId,
  elementId,
  loop,
  threads,
  onClose,
}: {
  artifactId: string;
  elementId: string | undefined;
  loop: Loop;
  threads: Thread[];
  onClose(): void;
}) {
  const record = useLiveQuery<Agreement[]>(
    "vc.DecisionRecord",
    { artifactId, elementId: elementId ?? "" },
    elementId !== undefined,
  );
  const entries = elementId ? whyEntries(record.data ?? [], threads, loop, elementId) : [];
  return (
    <Dialog
      open={elementId !== undefined}
      title="Why is this here?"
      lede="Every agreed change and Update that shaped this part, oldest first."
      onClose={onClose}
      onSubmit={onClose}
      buttons={
        <Button type="submit" variant="ghost">
          Close
        </Button>
      }
    >
      {record.loading ? (
        <p className="vc-muted">…</p>
      ) : entries.length === 0 ? (
        <p className="vc-muted">Nothing agreed has changed this yet. It is as it was written or imported.</p>
      ) : (
        <ol className="vc-why">
          {entries.map((e) => (
            <li key={e.key}>
              <span className="vc-facts">{e.when ? relativeTime(e.when) : ""}</span>
              <span className="text">{e.text}</span>
              {e.detail && <span className="detail">“{e.detail}”</span>}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
