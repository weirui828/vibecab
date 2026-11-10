import { Icon } from "@wei/design-system";
import type { AttentionItem } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";
import type { DraftRow, SessionRow } from "../live/workspace.js";
import { Mound } from "../ui/Brand.js";
import { Menu } from "../ui/Menu.js";
import type { MenuItem } from "../ui/Menu.js";
import { relativeTime } from "../ui/time.js";
import { sessionTone } from "../shell/Navigation.js";
import { attentionSentence, attentionTone } from "./attentionText.js";
import { useActions } from "./actions.js";
import { useDialogs } from "./DialogHost.js";
import { sessionStateItems } from "../session/SessionState.js";

const stateWord: Record<SessionRow["state"], string> = {
  active: terms.active,
  paused: terms.paused,
  ended: terms.ended,
};

export function SessionRows({
  sessions,
  drafts,
  attention,
}: {
  sessions: SessionRow[];
  drafts: DraftRow[];
  attention: Map<string, AttentionItem[]>;
}) {
  const actions = useActions(),
    dialogs = useDialogs(),
    titles = new Map(drafts.map((d) => [d.artifactId, d.title]));
  return (
    <ul className="vc-list">
      {sessions.map((session) => {
        const items = attention.get(session.sessionId) ?? [],
          names = session.artifactIds.map((id) => titles.get(id)).filter((t): t is string => Boolean(t));
        const sub = [
          session.state === "active" ? undefined : stateWord[session.state],
          names.length === 1 && names[0] === session.title
            ? `1 ${terms.draft}`
            : names.length
              ? names.join(" · ")
              : `No ${terms.draft.toLowerCase()} yet`,
        ]
          .filter(Boolean)
          .join(" — ");
        const menu: MenuItem[] = [
          { label: "Rename", onSelect: () => dialogs.rename("session", session.sessionId, session.title) },
          ...sessionStateItems(
            session,
            session.artifactIds.map((artifactId) => ({ artifactId })),
            actions,
            dialogs,
          ),
          {
            label: "Move to Trash",
            tone: "danger",
            separatorBefore: true,
            onSelect: () => void actions.trash("session", session.sessionId, session.title),
          },
        ];
        return (
          <li key={session.sessionId} className="vc-row">
            <span className="lead">
              <Mound tone={sessionTone(session, items)} />
            </span>
            <span className="main">
              <a className="title" href={"#/s/" + session.sessionId}>
                {session.title}
              </a>
              <span className="sub">{sub}</span>
            </span>
            <span className="end">
              {items.length > 0 && (
                <span className="vc-pill" title={attentionSentence(items)}>
                  {items.length}
                  <span className="sr-only"> waiting for you</span>
                </span>
              )}
              <Menu label={`Actions for ${session.title}`} items={menu} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function DraftRows({ drafts, sessions }: { drafts: DraftRow[]; sessions: SessionRow[] }) {
  const actions = useActions(),
    dialogs = useDialogs(),
    byId = new Map(sessions.map((s) => [s.sessionId, s]));
  return (
    <ul className="vc-list">
      {drafts.map((draft) => {
        const inSessions = draft.sessionIds.map((id) => byId.get(id)).filter((s): s is SessionRow => Boolean(s)),
          home = inSessions.find((s) => s.state === "active") ?? inSessions[0];
        const sub = [
          inSessions.length
            ? "In " + inSessions.map((s) => s.title).join(", ")
            : `Not in a ${terms.session.toLowerCase()} · opens in a new one`,
          `version ${draft.headVersion}`,
        ].join(" · ");
        return (
          <li key={draft.artifactId} className="vc-row">
            <span className="lead">
              <Icon name="document-text" size={20} />
            </span>
            <span className="main">
              {home ? (
                <a className="title" href={`#/s/${home.sessionId}/d/${draft.artifactId}`}>
                  {draft.title}
                </a>
              ) : (
                // A Draft is worked on in a session; one in none (restored, or left over) gets a new one.
                <button
                  type="button"
                  className="title vc-title-button"
                  onClick={() =>
                    void actions.continueSession(
                      draft.title,
                      [{ artifactId: draft.artifactId, role: "primary" }],
                      draft.artifactId,
                    )
                  }
                >
                  {draft.title}
                </button>
              )}
              <span className="sub">{sub}</span>
            </span>
            <span className="end">
              <span className="when">{relativeTime(draft.updatedAt)}</span>
              <Menu
                label={`Actions for ${draft.title}`}
                items={[
                  { label: "Rename", onSelect: () => dialogs.rename("artifact", draft.artifactId, draft.title) },
                  {
                    label: "Move to Trash",
                    tone: "danger",
                    separatorBefore: true,
                    onSelect: () => void actions.trash("artifact", draft.artifactId, draft.title),
                  },
                ]}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** One row per session: its waiting items as a sentence, the most urgent first. */
export function AttentionRows({
  sessions,
  attention,
  limit,
}: {
  sessions: SessionRow[];
  attention: Map<string, AttentionItem[]>;
  limit?: number;
}) {
  const rows = sessions
    .filter((s) => (attention.get(s.sessionId)?.length ?? 0) > 0)
    .slice(0, limit ?? Number.POSITIVE_INFINITY);
  return (
    <ul className="vc-list vc-attention">
      {rows.map((session) => {
        const items = attention.get(session.sessionId) ?? [];
        return (
          <li key={session.sessionId} className="vc-row">
            <span className="lead">
              <Mound tone={attentionTone(items)} />
            </span>
            <span className="main">
              <a className="title" href={"#/s/" + session.sessionId}>
                {session.title}
              </a>
              <span className="sub">{attentionSentence(items)}</span>
            </span>
            <span className="end">
              <Icon name="arrow-right" size={16} className="vc-muted" />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
