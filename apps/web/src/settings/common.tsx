import { useCallback } from "react";
import type { ReactNode } from "react";
import { errorMessage } from "../../../ui/src/copy/errors.js";
import { useBridge, useLiveQuery } from "../live/LiveStore.js";
import { useToast } from "../ui/Toast.js";
import { newCommandId } from "../bridge/webBridge.js";

/** A settings section: a heading, one sentence, then the controls. No cards inside cards. */
export function Section({
  id,
  title,
  lede,
  level = 2,
  children,
}: {
  id: string;
  title: string;
  lede?: string;
  /** 3 inside an agent's group, so the agent's name stays the heading above it. */
  level?: 2 | 3;
  children: ReactNode;
}) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <section className="vc-setting" data-level={level} id={id} aria-labelledby={id + "-title"}>
      <Heading id={id + "-title"}>{title}</Heading>
      {lede && <p className="lede">{lede}</p>}
      <div className="body">{children}</div>
    </section>
  );
}

/**
 * One agent in Settings → Agents: its name and what it is, then its own sections (model, replies, permissions,
 * tools...). A group with a heading, not a card, so nothing ends up as a card inside a card.
 */
export function AgentGroup({
  id,
  name,
  about,
  facts,
  children,
}: {
  id: string;
  name: string;
  about: string;
  facts?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="vc-agent" id={id} aria-labelledby={id + "-name"}>
      <header>
        <h2 id={id + "-name"}>{name}</h2>
        <p className="lede">{about}</p>
        {facts && <p className="vc-facts">{facts}</p>}
      </header>
      {children}
    </section>
  );
}

/** Names for agent ids without a name of their own: the built-in ids, and "vibecab" from before the pool (W13). */
export const agentNames: Record<string, string> = {
  default: "Main agent",
  vibecab: "VibeCab agent",
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** What to call an agent id: the name it was given in the pool, else a built-in name, else the id. */
export function useAgentName(): (id: string) => string {
  const settings = useLiveQuery<{ models?: Record<string, { name?: string }> }>("sys.Settings", {});
  return (id) => settings.data?.models?.[id]?.name?.trim() || agentNames[id] || id;
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
