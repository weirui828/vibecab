import { terms } from "../../../ui/src/copy/terms.js";
import { useActions } from "../home/actions.js";
import { useDialogs } from "../home/DialogHost.js";
import type { SessionRow } from "../live/workspace.js";
import { Menu } from "../ui/Menu.js";
import type { MenuItem } from "../ui/Menu.js";

const word: Record<SessionRow["state"], string> = { active: terms.active, paused: terms.paused, ended: terms.ended };

/** The ways on from each state: active ⇄ paused, either → ended (confirmed), ended → a new session. */
export function sessionStateItems(
  session: SessionRow,
  drafts: Array<{ artifactId: string; role?: "primary" | "reference" | undefined }>,
  actions: ReturnType<typeof useActions>,
  dialogs: ReturnType<typeof useDialogs>,
): MenuItem[] {
  const s = terms.session.toLowerCase();
  if (session.state === "ended")
    return drafts.length
      ? [
          {
            label: `Continue in a new ${s}`,
            onSelect: () => void actions.continueSession(session.title, drafts, drafts[0]!.artifactId),
          },
        ]
      : [];
  return [
    session.state === "active"
      ? { label: "Pause", onSelect: () => void actions.setSessionState(session.sessionId, "pause") }
      : { label: "Resume", onSelect: () => void actions.setSessionState(session.sessionId, "resume") },
    { label: `End ${s}…`, onSelect: () => dialogs.endSession(session) },
  ];
}

/** The session's state, always in sight, and the menu of where it can go next. */
export function SessionState({
  session,
  drafts,
}: {
  session: SessionRow;
  drafts: Array<{ artifactId: string; role?: "primary" | "reference" | undefined }>;
}) {
  const actions = useActions(),
    dialogs = useDialogs();
  return (
    <span className="vc-state" data-state={session.state}>
      <Menu
        label={`${terms.session} state: ${word[session.state]}`}
        items={sessionStateItems(session, drafts, actions, dialogs)}
        text={
          <>
            <span className="dot" aria-hidden="true" />
            {word[session.state]}
          </>
        }
      />
    </span>
  );
}
