import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { terms } from "../../../ui/src/copy/terms.js";
import type { SessionRow } from "../live/workspace.js";
import { useActions } from "./actions.js";
import type { TrashKind } from "./actions.js";
import { NewDraftDialog, TitleDialog } from "./Dialogs.js";

interface Dialogs {
  newDraft(): void;
  newSession(): void;
  rename(kind: TrashKind, id: string, title: string): void;
}
const DialogContext = createContext<Dialogs>({ newDraft() {}, newSession() {}, rename() {} });
export const useDialogs = () => useContext(DialogContext);

type Open = { kind: "draft" } | { kind: "session" } | { kind: "rename"; target: TrashKind; id: string; title: string };

export function DialogHost({ sessions, children }: { sessions: SessionRow[]; children: ReactNode }) {
  const [open, setOpen] = useState<Open>(),
    actions = useActions(),
    close = () => setOpen(undefined);
  const api = useMemo<Dialogs>(
    () => ({
      newDraft: () => setOpen({ kind: "draft" }),
      newSession: () => setOpen({ kind: "session" }),
      rename: (target, id, title) => setOpen({ kind: "rename", target, id, title }),
    }),
    [],
  );
  const rename = open?.kind === "rename" ? open : undefined;
  return (
    <DialogContext.Provider value={api}>
      {children}
      <NewDraftDialog
        open={open?.kind === "draft"}
        sessions={sessions}
        onClose={close}
        onCreate={actions.createDraft}
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
    </DialogContext.Provider>
  );
}
