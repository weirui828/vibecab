import { useCallback } from "react";
import { errorMessage } from "../../../ui/src/copy/errors.js";
import { terms } from "../../../ui/src/copy/terms.js";
import { useBridge } from "../live/LiveStore.js";
import { useToast } from "../ui/Toast.js";
import { navigate } from "../shell/prefs.js";
import { newCommandId } from "../bridge/webBridge.js";

export type TrashKind = "artifact" | "session";
export type Trashable = TrashKind | "idea" | "project";

export interface NewDraft {
  title: string;
  markdown?: string;
  /** Existing session to add the Draft to; a new session named after the Draft otherwise. */
  sessionId?: string;
  /** The first Draft in a session is its primary one. */
  role?: "primary" | "reference";
}

/** Workspace actions shared by Home, Drafts and Needs you. Errors become short toasts. */
export function useActions() {
  const bridge = useBridge(),
    toast = useToast();
  const run = useCallback(
    async <T>(type: string, payload: unknown, commandId = newCommandId()): Promise<T | undefined> => {
      const result = await bridge.command(type, payload, commandId);
      if (!result.ok) {
        toast(errorMessage(result.error.code));
        return undefined;
      }
      return result.result as T;
    },
    [bridge, toast],
  );
  return {
    async createDraft({ title, markdown, sessionId, role = "primary" }: NewDraft): Promise<boolean> {
      const created =
        markdown === undefined
          ? await run<{ artifactId: string }>("vc.CreateArtifact", { title, mediaKind: "doc" })
          : await run<{ artifactId: string }>("vc.ImportContent", { title, format: "markdown", content: markdown });
      if (!created) return false;
      const target = sessionId ?? (await run<{ sessionId: string }>("vc.StartSession", { title }))?.sessionId;
      if (!target) return false;
      const attached = await run("vc.AttachArtifact", {
        sessionId: target,
        artifactId: created.artifactId,
        role: sessionId ? role : "primary",
      });
      if (attached) navigate(`/s/${target}/d/${created.artifactId}`);
      return attached !== undefined;
    },
    async attach(sessionId: string, artifactId: string, role: "primary" | "reference"): Promise<boolean> {
      const attached = await run("vc.AttachArtifact", { sessionId, artifactId, role });
      if (attached) navigate(`/s/${sessionId}/d/${artifactId}`);
      return attached !== undefined;
    },
    async startSession(title: string): Promise<boolean> {
      const started = await run<{ sessionId: string }>("vc.StartSession", { title });
      if (started) navigate("/s/" + started.sessionId);
      return started !== undefined;
    },
    async rename(kind: TrashKind, id: string, title: string): Promise<boolean> {
      return (
        (kind === "artifact"
          ? await run("vc.RenameArtifact", { artifactId: id, title })
          : await run("vc.RenameSession", { sessionId: id, title })) !== undefined
      );
    },
    async setSessionSettings(sessionId: string, patch: { planReview?: boolean }) {
      await run("sys.SetSettings", { patch: { sessions: { [sessionId]: patch } } });
    },
    async setSessionState(sessionId: string, to: "pause" | "resume" | "end") {
      const type = to === "pause" ? "vc.PauseSession" : to === "resume" ? "vc.ResumeSession" : "vc.EndSession";
      await run(type, { sessionId });
    },
    async trash(kind: Trashable, id: string, title: string) {
      const target = { kind, id };
      if ((await run("vc.Trash", { target })) === undefined) return;
      toast(`“${title}” moved to Trash`, {
        label: "Undo",
        run: () => void run("vc.Restore", { target }),
      });
    },
    sessionWord: terms.session,
  };
}
