import type { AnchorResolution, Element, FeedbackComment, Thread } from "../../../../contract/generated/index.js";
import { inlineMarkdownToPlainText, locateQuote } from "../../../../contract/src/inline-markdown.js";
import { buildTree } from "../document/DocumentView.js";
import { terms } from "../../../ui/src/copy/terms.js";

export type { Thread, FeedbackComment };

export interface ThreadFilter {
  status: "open" | "all";
  who: "everyone" | "mine" | "agent";
  suggestion: boolean;
}
export const defaultFilter: ThreadFilter = { status: "open", who: "everyone", suggestion: false };

const closed = new Set(["applied", "declined", "superseded"]);

export const anchorOf = (thread: Thread) => thread.comments[0]?.anchor;
export const resolutionOf = (thread: Thread): AnchorResolution | undefined => thread.anchorResolutions[0];
// System notices the card already says in words (its status line), written by the engine with internal ids.
const restated = [/^Conflict conflict_/, /^Agreed item applied in version \d+\.?$/];
export const visibleComments = (thread: Thread) =>
  thread.comments.filter((c) => !c.deleted && !(c.author.kind === "system" && restated.some((r) => r.test(c.body))));

const progress: Array<FeedbackComment["state"]> = [
  "open",
  "discussing",
  "agreed",
  "scheduled",
  "declined",
  "superseded",
  "applied",
];
/** The thread's state is the furthest any of its human or agent comments has come (an agreed reply counts). */
export function threadState(thread: Thread): FeedbackComment["state"] {
  return thread.comments
    .filter((c) => c.author.kind !== "system" && !c.deleted)
    .reduce<FeedbackComment["state"]>(
      (best, c) => (progress.indexOf(c.state) > progress.indexOf(best) ? c.state : best),
      "open",
    );
}

/** Threads on this Draft, plus the session's general ones (no anchor). */
export function threadsForDraft(threads: Thread[], artifactId: string | undefined): Thread[] {
  return threads.filter((t) => {
    const anchor = anchorOf(t);
    return visibleComments(t).length > 0 && (!anchor || anchor.artifactId === artifactId);
  });
}

export function applyFilter(threads: Thread[], filter: ThreadFilter): Thread[] {
  return threads.filter((t) => {
    if (filter.status === "open" && closed.has(threadState(t))) return false;
    const comments = visibleComments(t);
    if (filter.who === "mine" && !comments.some((c) => c.author.kind === "human")) return false;
    if (filter.who === "agent" && !comments.some((c) => c.author.kind === "agent")) return false;
    if (filter.suggestion && !comments.some((c) => c.suggestion !== undefined || c.proposal !== undefined))
      return false;
    return true;
  });
}

export function authorLabel(comment: FeedbackComment): string {
  if (comment.author.kind === "agent") return "Agent";
  if (comment.author.kind === "system") return "VibeCab";
  if (comment.channel === "mcp") return "You · via MCP";
  if (comment.channel === "cli") return "You · via CLI";
  return "You";
}

const stateWords: Record<FeedbackComment["state"], string> = {
  open: terms.open,
  discussing: terms.discussing,
  agreed: terms.agreed,
  scheduled: terms.scheduled,
  applied: terms.applied,
  declined: terms.declined,
  superseded: terms.superseded,
};
export const stateLabel = (state: FeedbackComment["state"]) => stateWords[state];

export type Delivery = "saved" | "queued" | "delivered" | "replied" | "handled";
export type TurnStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "uncertain";

/**
 * What the card says about the agent. `delivered` alone is not enough: the engine keeps it after a turn that
 * finished without replying, so the turn's own status decides between "replying" and nothing.
 */
export function deliveryLabel(state: Delivery | undefined, turn: TurnStatus | undefined): string | undefined {
  if (state === "queued") return "Waiting for the agent";
  if (state !== "delivered") return undefined;
  if (turn === "failed" || turn === "uncertain") return "The agent could not reply";
  if (turn === undefined || turn === "queued" || turn === "running") return "The agent is replying…";
  return undefined;
}

/** The comment whose delivery the card reports: the latest human comment. */
export function latestHuman(thread: Thread): FeedbackComment | undefined {
  return [...visibleComments(thread)].reverse().find((c) => c.author.kind === "human");
}

/**
 * Reading order: by the anchored element's place in the Document (depth-first), then by where the quote starts;
 * threads without a place (general, or their part was removed) come last, oldest first.
 */
export function sortByPosition(threads: Thread[], elements: Element[]): Thread[] {
  const { roots, children } = buildTree(elements),
    position = new Map<string, number>();
  const walk = (list: Element[]) => {
    for (const element of list) {
      position.set(element.elementId, position.size);
      walk(children.get(element.elementId) ?? []);
    }
  };
  walk(roots);
  const byId = new Map(elements.map((e) => [e.elementId, e]));
  const key = (thread: Thread): [number, number] => {
    const anchor = anchorOf(thread);
    if (!anchor || resolutionOf(thread)?.state === "removed") return [Number.MAX_SAFE_INTEGER, 0];
    const at = position.get(anchor.elementId) ?? Number.MAX_SAFE_INTEGER - 1,
      element = byId.get(anchor.elementId);
    const offset =
      anchor.locator && element && "text" in element
        ? (locateQuote(inlineMarkdownToPlainText(element.text), anchor.locator)?.start ?? 0)
        : 0;
    return [at, offset];
  };
  return threads
    .map((thread, index) => ({ thread, index, key: key(thread) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
    .map(({ thread }) => thread);
}
