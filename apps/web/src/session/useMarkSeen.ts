import { useCallback, useEffect, useRef } from "react";
import { useBridge } from "../live/LiveStore.js";

const DWELL_MS = 3000;

/** Sends `vc.MarkSeen` once the session has been in view for 3 s with the tab visible and focused. */
export function useMarkSeen(sessionId: string): () => void {
  const bridge = useBridge(),
    sent = useRef(false);
  const mark = useCallback(() => {
    if (sent.current) return;
    sent.current = true;
    void bridge.command("vc.MarkSeen", { sessionId });
  }, [bridge, sessionId]);
  useEffect(() => {
    sent.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const watching = document.visibilityState === "visible" && (document.hasFocus?.() ?? true);
      if (watching && !sent.current) timer = setTimeout(mark, DWELL_MS);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    window.addEventListener("focus", arm);
    window.addEventListener("blur", arm);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
      window.removeEventListener("focus", arm);
      window.removeEventListener("blur", arm);
    };
  }, [mark]);
  return mark;
}
