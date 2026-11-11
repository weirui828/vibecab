import { useCallback } from "react";
import { errorMessage } from "../copy/errors.js";
import { terms } from "../copy/terms.js";
import { useBridge } from "../live/LiveStore.js";
import { useToast } from "../ui/Toast.js";
import { navigate } from "../shell/prefs.js";
import { newCommandId } from "../bridge/webBridge.js";

export type TrashKind = "artifact" | "session";
export type Trashable = TrashKind | "idea" | "project";

export interface NewDraft {
  title: string;
  markdown?: string;
  /** An HTML file, kept as it is. */
  html?: string;
  /** Existing session to add the Draft to; a new session named after the Draft otherwise. */
  sessionId?: string;
  /** The first Draft in a session is its primary one. */
  role?: "primary" | "reference";
  /** The existing session is paused: resume it first, since Drafts join only active sessions. */
  resume?: boolean;
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
    async createDraft({ title, markdown, html, sessionId, role = "primary", resume }: NewDraft): Promise<boolean> {
      // Resume before creating, so a refusal never leaves a Draft behind with no session.
      if (sessionId && resume && (await run("vc.ResumeSession", { sessionId })) === undefined) return false;
      const created =
        html !== undefined
          ? await run<{ artifactId: string }>("vc.ImportContent", { title, format: "html", content: html })
          : markdown === undefined
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
    async attach(
      sessionId: string,
      artifactId: string,
      role: "primary" | "reference",
      resume = false,
    ): Promise<boolean> {
      if (resume && (await run("vc.ResumeSession", { sessionId })) === undefined) return false;
      const attached = await run("vc.AttachArtifact", { sessionId, artifactId, role });
      if (attached) navigate(`/s/${sessionId}/d/${artifactId}`);
      return attached !== undefined;
    },
    async startSession(title: string): Promise<boolean> {
      const started = await run<{ sessionId: string }>("vc.StartSession", { title });
      if (started) navigate("/s/" + started.sessionId);
      return started !== undefined;
    },
    /**
     * An ended session is read-only: carry on with the same Drafts in a new session, which opens on `open`.
     * The ended one keeps its threads as they were.
     */
    async continueSession(
      title: string,
      drafts: Array<{ artifactId: string; role?: "primary" | "reference" | undefined }>,
      open: string,
    ): Promise<boolean> {
      const started = await run<{ sessionId: string }>("vc.StartSession", { title });
      if (!started) return false;
      const primary = drafts.find((d) => d.role === "primary") ?? drafts[0];
      for (const draft of drafts) {
        const role = draft === primary ? "primary" : "reference";
        if (
          (await run("vc.AttachArtifact", { sessionId: started.sessionId, artifactId: draft.artifactId, role })) ===
          undefined
        )
          return false;
      }
      navigate(`/s/${started.sessionId}/d/${open}`);
      return true;
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
