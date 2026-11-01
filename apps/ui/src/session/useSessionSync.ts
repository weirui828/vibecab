import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { coalesce } from "../coalesce.js";

export type SessionArtifact = { artifactId: string; title: string; headVersion: number };

/** Keeps the Session view in sync: live events, version toast, scroll anchoring and MarkSeen. */
export function useSessionSync({
  artifact,
  sessionId,
  refresh,
  onRefresh,
  setArtifacts,
  setViewingVersion,
  setUpdatedToast,
  setPendingExportId,
}: {
  artifact: SessionArtifact | undefined;
  sessionId: string;
  refresh: () => Promise<void>;
  onRefresh: () => void;
  setArtifacts: Dispatch<SetStateAction<SessionArtifact[]>>;
  setViewingVersion: Dispatch<SetStateAction<number | undefined>>;
  setUpdatedToast: Dispatch<SetStateAction<string>>;
  setPendingExportId: Dispatch<SetStateAction<string | undefined>>;
}): void {
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => void (onRefreshRef.current = onRefresh), [onRefresh]);
  useEffect(() => {
    const refresher = coalesce(refresh),
      mountedAt = Date.now();
    const unsub = window.vibecab.subscribe(0, {}, (event) => {
      // Subscriptions replay history from seq 0; only events newer than this view may toast or move the reader.
      const live = Date.parse(event.ts) >= mountedAt - 1_000;
      if (
        event.type === "vc.VersionCommitted" &&
        artifact &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        Reflect.get(event.payload, "artifactId") === artifact.artifactId
      ) {
        const version = Reflect.get(event.payload, "version");
        // Replayed history still advances the head; only live commits toast and move the reader.
        if (typeof version === "number")
          setArtifacts((current) =>
            current.map((item) =>
              item.artifactId === artifact.artifactId
                ? { ...item, headVersion: Math.max(item.headVersion, version) }
                : item,
            ),
          );
        if (live) {
          setUpdatedToast(typeof version === "number" ? `Updated to v${version}` : "Document updated");
          setViewingVersion(undefined);
          const topId = document.elementFromPoint(220, 100)?.closest<HTMLElement>("[data-element-id]")
            ?.dataset.elementId;
          onRefreshRef.current();
          window.requestAnimationFrame(() => {
            if (topId)
              document.querySelector(`[data-element-id="${CSS.escape(topId)}"]`)?.scrollIntoView({ block: "start" });
          });
        }
      }
      if (
        [
          "vc.VersionCommitted",
          "vc.CommentPosted",
          "vc.CommentEdited",
          "vc.CommentDeleted",
          "vc.DeliveryStateChanged",
          "vc.AgentTurnChanged",
        ].includes(event.type)
      )
        refresher.schedule();
      if (
        event.type === "vc.LifecycleChanged" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        Reflect.get(event.payload, "kind") === "export" &&
        Reflect.get(event.payload, "action") === "completed"
      ) {
        const exportId = Reflect.get(event.payload, "id");
        if (typeof exportId === "string") setPendingExportId(exportId);
      }
    });
    const fallback = window.setInterval(() => refresher.schedule(), 1_500);
    return () => {
      refresher.stop();
      unsub();
      window.clearInterval(fallback);
    };
  }, [artifact, refresh, setArtifacts, setViewingVersion, setUpdatedToast, setPendingExportId]);
  useEffect(() => {
    let timer: number | undefined;
    const mark = () => {
      if (document.hasFocus())
        timer = window.setTimeout(() => {
          void window.vibecab.command("vc.MarkSeen", { sessionId });
        }, 3000);
    };
    const focus = () => mark(),
      blur = () => {
        if (timer) window.clearTimeout(timer);
      };
    mark();
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, [sessionId]);
}
