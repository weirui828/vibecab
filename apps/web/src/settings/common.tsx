import { useCallback } from "react";
import type { ReactNode } from "react";
import { errorMessage } from "../../../ui/src/copy/errors.js";
import { useBridge } from "../live/LiveStore.js";
import { useToast } from "../ui/Toast.js";
import { newCommandId } from "../bridge/webBridge.js";

/** A settings section: a heading, one sentence, then the controls. No cards inside cards. */
export function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <section className="vc-setting" id={id} aria-labelledby={id + "-title"}>
      <h2 id={id + "-title"}>{title}</h2>
      {lede && <p className="lede">{lede}</p>}
      <div className="body">{children}</div>
    </section>
  );
}

/** Runs a command; errors become a toast. Returns the result, or undefined on failure. */
export function useRun() {
  const bridge = useBridge(),
    toast = useToast();
  return useCallback(
    async <T,>(type: string, payload: unknown): Promise<T | undefined> => {
      const result = await bridge.command(type, payload, newCommandId());
      if (!result.ok) {
        toast(errorMessage(result.error.code));
        return undefined;
      }
      return result.result as T;
    },
    [bridge, toast],
  );
}

/** Integer micro-units ⇄ dollars, as typed and shown. */
export const dollars = (micros: number) => (micros / 1_000_000).toFixed(micros % 10_000 === 0 ? 2 : 4);
export const toMicros = (text: string) => {
  const value = Number(text.replace(/[$,\s]/g, ""));
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) : undefined;
};
