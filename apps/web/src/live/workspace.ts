import type { AttentionItem, VcArtifactsOperation, VcSessionsOperation } from "../../../../contract/generated/index.js";
import { useLiveQuery } from "./LiveStore.js";

export type SessionRow = VcSessionsOperation["result"][number];
export type DraftRow = VcArtifactsOperation["result"][number];

export interface SessionAttention {
  sessionId: string;
  items: AttentionItem[];
}

/** Everything Home and the shell show, kept live from events. */
export function useWorkspace(enabled = true) {
  const sessions = useLiveQuery<VcSessionsOperation["result"]>("vc.Sessions", {}, enabled),
    drafts = useLiveQuery<VcArtifactsOperation["result"]>("vc.Artifacts", {}, enabled),
    inbox = useLiveQuery<AttentionItem[]>("vc.AttentionInbox", {}, enabled);
  const attention = new Map<string, AttentionItem[]>();
  for (const item of inbox.data ?? []) {
    if (!item.sessionId) continue;
    attention.set(item.sessionId, [...(attention.get(item.sessionId) ?? []), item]);
  }
  return {
    sessions: sessions.data,
    drafts: drafts.data,
    inbox: inbox.data,
    attention,
    loading: sessions.loading || drafts.loading || inbox.loading,
    error: sessions.error ?? drafts.error ?? inbox.error,
    refresh() {
      sessions.refresh();
      drafts.refresh();
      inbox.refresh();
    },
  };
}

const stateRank = { active: 0, paused: 1, ended: 2 } as const;

/** Sessions that need you first, then active, then paused, then ended; newest first within each. */
export function sortSessions(sessions: SessionRow[], attention: Map<string, AttentionItem[]>): SessionRow[] {
  const waiting = (id: string) => Number((attention.get(id)?.length ?? 0) > 0);
  return [...sessions].sort(
    (a, b) =>
      waiting(b.sessionId) - waiting(a.sessionId) ||
      stateRank[a.state] - stateRank[b.state] ||
      b.createdAt.localeCompare(a.createdAt),
  );
}
