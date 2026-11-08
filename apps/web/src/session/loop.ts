import type {
  Agreement,
  FeedbackConflict,
  Grant,
  Update,
  VcUpdatesOperation,
} from "../../../../contract/generated/index.js";
import { terms } from "../../../ui/src/copy/terms.js";
import { useLiveQuery } from "../live/LiveStore.js";
import type { Thread } from "./threads.js";
import { visibleComments } from "./threads.js";

export type { Agreement, FeedbackConflict, Update };
export type SessionAgent = "vibecab" | "claude-code" | "codex";
/** The agents that can work here: the VibeCab agent when it has a default model, and Claude Code and Codex when on. */
export function available(models: Record<string, unknown> | undefined): SessionAgent[] {
  return (["vibecab", "claude-code", "codex"] as const).filter((id) =>
    Boolean(models?.[id === "vibecab" ? "default" : id]),
  );
}
export const agentWords: Record<SessionAgent, string> = {
  vibecab: "VibeCab agent",
  "claude-code": "Claude Code",
  codex: "Codex",
};

const running = new Set(["queued", "planning", "awaiting_plan_review", "writing", "checking"]);
export const isRunning = (update: Update) => running.has(update.status);

/** Everything the agreement-to-Update loop shows for one Draft in one session, kept live. */
export function useLoop(sessionId: string, artifactId: string, enabled = true) {
  const agreements = useLiveQuery<Agreement[]>("vc.DecisionRecord", { artifactId }, enabled),
    updates = useLiveQuery<VcUpdatesOperation["result"]>("vc.Updates", { artifactId }, enabled),
    conflicts = useLiveQuery<FeedbackConflict[]>("vc.Conflicts", { sessionId, artifactId }, enabled),
    settings = useLiveQuery<{
      models?: Record<string, unknown>;
      sessions?: Record<string, { planReview?: boolean; agent?: SessionAgent }>;
    }>("sys.Settings", {}),
    grants = useLiveQuery<Grant[]>("vc.Grants", {});
  const list = [...(updates.data?.updates ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    agreements: agreements.data ?? [],
    updates: list,
    current: list.find(isRunning),
    latest: list.at(-1),
    scheduledAt: updates.data?.scheduledAt,
    conflicts: (conflicts.data ?? []).filter((c) => c.state === "open"),
    // Any agent with a model is enough to work with: the VibeCab agent's default model, or Claude Code / Codex alone.
    modelReady: settings.data ? available(settings.data.models).length > 0 : true,
    planReview: settings.data?.sessions?.[sessionId]?.planReview === true,
    // Who replies here (W12): the agents that are set up, and the session's choice among them — else the first
    // one, as the engine does (the VibeCab agent when it has a model, else Claude Code, else Codex).
    agents: settings.data ? available(settings.data.models) : (["vibecab"] as SessionAgent[]),
    agent: ((): SessionAgent => {
      const set = settings.data ? available(settings.data.models) : (["vibecab"] as SessionAgent[]),
        chosen = settings.data?.sessions?.[sessionId]?.agent;
      return chosen && set.includes(chosen) ? chosen : (set[0] ?? "vibecab");
    })(),
    autoAgree: (grants.data ?? []).some(
      (g) =>
        !g.revokedAt &&
        (!g.expiresAt || Date.parse(g.expiresAt) > Date.now()) &&
        g.capabilities?.includes("auto_agree_own_proposals") &&
        (!g.scope?.sessionIds || g.scope.sessionIds.includes(sessionId)),
    ),
  };
}
export type Loop = ReturnType<typeof useLoop>;

/** Agreed comments on this Draft, waiting for an Update (not in a running one). */
export function waitingAgreements(loop: Loop): Agreement[] {
  const inFlight = new Set(loop.current?.itemIds ?? []);
  return loop.agreements.filter((a) => a.state === "agreed" && !inFlight.has(a.agreementId));
}

export interface ThreadStatus {
  text: string;
  tone: "agreed" | "applied" | "declined" | "muted" | "warning";
  appliedIn?: number;
}

/** One line saying where the thread stands in the loop, or undefined when nothing has been decided. */
export function threadStatus(thread: Thread, loop: Loop): ThreadStatus | undefined {
  const comments = visibleComments(thread),
    ids = new Set(comments.map((c) => c.commentId));
  const agreement = loop.agreements
    .filter((a) => ids.has(a.commentId))
    .sort((a, b) => (a.agreedAt ?? "").localeCompare(b.agreedAt ?? ""))
    .at(-1);
  if (loop.conflicts.some((c) => agreement && c.itemIds.includes(agreement.agreementId)))
    return { text: "Conflicts with another agreed change", tone: "warning" };
  if (agreement) {
    const update = terms.update;
    if (agreement.state === "applied") {
      const version = comments.find((c) => c.commentId === agreement.commentId)?.appliedInVersion;
      return {
        text: version ? `Applied in version ${version}` : terms.applied,
        tone: "applied",
        ...(version ? { appliedIn: version } : {}),
      };
    }
    if (agreement.state === "superseded") return { text: terms.superseded, tone: "muted" };
    if (agreement.state === "scheduled" || loop.current?.itemIds.includes(agreement.agreementId))
      return { text: `In an ${update}`, tone: "agreed" };
    const missed = [...loop.updates]
      .reverse()
      .flatMap((u) => u.itemResults)
      .find((r) => r.itemId === agreement.agreementId && r.status === "not_addressed");
    if (missed) return { text: `Not applied${missed.reason ? ": " + missed.reason : ""}`, tone: "warning" };
    if (loop.current) return { text: `${terms.agreed} — will go into the next ${update}`, tone: "agreed" };
    return { text: `${terms.agreed} — waiting for the next ${update}`, tone: "agreed" };
  }
  const declined = comments.find((c) => c.state === "declined");
  if (declined)
    return { text: terms.declined + (declined.declineReason ? `: ${declined.declineReason}` : ""), tone: "declined" };
  return undefined;
}

/** Whether the thread can still be agreed to: nothing agreed or declined yet. */
export function canDecide(thread: Thread, loop: Loop): boolean {
  const ids = new Set(thread.comments.map((c) => c.commentId));
  if (loop.agreements.some((a) => ids.has(a.commentId) && a.state !== "superseded")) return false;
  return thread.comments.every((c) => !["declined", "agreed", "scheduled", "applied"].includes(c.state));
}

/** "in 12 min", "in 40 s", "now" — for the Update countdown. */
export function startsIn(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Number.isNaN(seconds)) return undefined;
  if (seconds <= 5) return "now";
  if (seconds < 60) return `in ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} h`;
}
