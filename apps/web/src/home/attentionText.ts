import type { AttentionItem } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";
import type { MoundTone } from "../ui/Brand.js";

type Kind = AttentionItem["kind"];
const order: Kind[] = [
  "conflict",
  "failed_update",
  "proposal",
  "unread_reply",
  "agreed_item",
  "running_update",
  "new_version",
  "output_set",
];

function phrase(kind: Kind, count: number): string {
  const n = (one: string, many: string) => (count === 1 ? one : `${count} ${many}`);
  const update = terms.update.toLowerCase();
  switch (kind) {
    case "conflict":
      return n("two agreed changes conflict", "conflicts to settle");
    case "failed_update":
      return n(`an ${update} failed`, `${update}s failed`);
    case "proposal":
      return n("the agent proposes a change", "proposals from the agent");
    case "unread_reply":
      return n("a new reply", "new replies");
    case "agreed_item":
      return n(`an agreed change waits for the next ${update}`, `agreed changes wait for the next ${update}`);
    case "running_update":
      return n(`an ${update} is running`, `${update}s running`);
    case "new_version":
      return n("a new version", "new versions");
    case "output_set":
      return n(`a new ${terms.snapshot.toLowerCase()}`, `new ${terms.snapshot.toLowerCase()}s`);
  }
}

/** One sentence for a session's waiting items, most urgent first: "A new reply, and 2 agreed changes wait…". */
export function attentionSentence(items: AttentionItem[]): string {
  const counts = new Map<Kind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const parts = order.filter((kind) => counts.has(kind)).map((kind) => phrase(kind, counts.get(kind) ?? 0));
  const text = parts.length <= 1 ? (parts[0] ?? "") : parts.slice(0, -1).join(", ") + " and " + parts.at(-1);
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

/** Items that ask the person to act (as opposed to news). */
export function needsAction(items: AttentionItem[]): boolean {
  return items.some((item) => ["conflict", "failed_update", "proposal", "unread_reply"].includes(item.kind));
}

export function attentionTone(items: AttentionItem[]): MoundTone {
  if (items.some((item) => item.kind === "conflict" || item.kind === "failed_update")) return "danger";
  if (items.some((item) => item.kind === "running_update")) return "agent";
  return "attention";
}
