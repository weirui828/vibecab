import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { terms } from "../../../ui/src/copy/terms.js";
import type { DraftRow, SessionRow } from "../live/workspace.js";
import { useActions } from "./actions.js";
import type { TrashKind } from "./actions.js";
import { Button } from "@wei/design-system";
import { Dialog } from "../ui/Dialog.js";
import { AttachDialog, NewDraftDialog, TitleDialog } from "./Dialogs.js";

interface Dialogs {
  newDraft(sessionId?: string): void;
  attachDraft(sessionId: string): void;
  newSession(): void;
  rename(kind: TrashKind, id: string, title: string): void;
  /** Ending cannot be undone, so it is always confirmed. */
  endSession(session: SessionRow): void;
}
const DialogContext = createContext<Dialogs>({
  newDraft() {},
  attachDraft() {},
  newSession() {},
  rename() {},
  endSession() {},
});
export const useDialogs = () => useContext(DialogContext);

type Open =
  | { kind: "draft"; sessionId?: string }
  | { kind: "attach"; sessionId: string }
  | { kind: "session" }
  | { kind: "rename"; target: TrashKind; id: string; title: string }
  | { kind: "end"; session: SessionRow };

export function DialogHost({
  sessions,
  drafts,
  children,
}: {
  sessions: SessionRow[];
  drafts: DraftRow[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState<Open>(),
    actions = useActions(),
    close = () => setOpen(undefined);
  const api = useMemo<Dialogs>(
    () => ({
      newDraft: (sessionId?: string) => setOpen(sessionId ? { kind: "draft", sessionId } : { kind: "draft" }),
      attachDraft: (sessionId: string) => setOpen({ kind: "attach", sessionId }),
      newSession: () => setOpen({ kind: "session" }),
      endSession: (session: SessionRow) => setOpen({ kind: "end", session }),
      rename: (target, id, title) => setOpen({ kind: "rename", target, id, title }),
    }),
    [],
  );
  const rename = open?.kind === "rename" ? open : undefined,
    fixed = open?.kind === "draft" && open.sessionId ? sessions.find((s) => s.sessionId === open.sessionId) : undefined,
    attachTo = open?.kind === "attach" ? sessions.find((s) => s.sessionId === open.sessionId) : undefined;
  return (
    <DialogContext.Provider value={api}>
      {children}
      <NewDraftDialog
        open={open?.kind === "draft"}
        sessions={sessions}
        {...(fixed ? { fixedSession: fixed } : {})}
        onClose={close}
        onCreate={actions.createDraft}
      />
      <AttachDialog
        open={open?.kind === "attach"}
        session={attachTo}
        drafts={drafts}
        onClose={close}
        onAttach={(artifactId) =>
          attachTo
            ? actions.attach(
                attachTo.sessionId,
                artifactId,
                attachTo.artifactIds.length ? "reference" : "primary",
                attachTo.state === "paused",
              )
            : Promise.resolve(false)
        }
      />
      <TitleDialog
        open={open?.kind === "session"}
        title={`New ${terms.session.toLowerCase()}`}
        lede={`A ${terms.session.toLowerCase()} is where you and the agent work on one or more ${terms.draft.toLowerCase()}s.`}
        submitLabel="Start"
        onClose={close}
        onSubmit={actions.startSession}
      />
      <TitleDialog
        open={rename !== undefined}
        title={
          rename?.target === "artifact"
            ? `Rename ${terms.draft.toLowerCase()}`
            : `Rename ${terms.session.toLowerCase()}`
        }
        initial={rename?.title ?? ""}
        submitLabel="Rename"
        onClose={close}
        onSubmit={(title) => (rename ? actions.rename(rename.target, rename.id, title) : Promise.resolve(false))}
      />
      <Dialog
        open={open?.kind === "end"}
        children={null}
        title={`End “${open?.kind === "end" ? open.session.title : ""}”?`}
        lede={`An ended ${terms.session.toLowerCase()} is kept as a record and can no longer change: no new comments or ${terms.update}s, and it cannot be resumed. To stop for a while instead, pause it.`}
        onClose={close}
        onSubmit={() => {
          if (open?.kind === "end") void actions.setSessionState(open.session.sessionId, "end");
          close();
        }}
        buttons={
          <>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            {open?.kind === "end" && open.session.state === "active" && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void actions.setSessionState(open.session.sessionId, "pause");
                  close();
                }}
              >
                Pause instead
              </Button>
            )}
            <Button type="submit" variant="primary">
              End {terms.session.toLowerCase()}
            </Button>
          </>
        }
      />
    </DialogContext.Provider>
  );
}
