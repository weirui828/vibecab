import type { Settings } from "../../contract/src/index.js";

export function sessionPreferences(settings: Settings, sessionId: string): Settings["sessions"][string] {
  return { ...settings.sessions.default, ...settings.sessions[sessionId] };
}

/**
 * The model a session's work runs on when no alias is set for that role: the default model, else the session's chosen
 * SDK agent, else any SDK agent that is set up — so Claude Code or Codex alone is enough to work with (W12).
 */
export function baseModelRef(settings: Settings, sessionId?: string): string {
  if (settings.models.default) return "default";
  const chosen = sessionId ? sessionPreferences(settings, sessionId)?.agent : undefined;
  if (chosen && chosen !== "vibecab" && settings.models[chosen]) return chosen;
  return ["claude-code", "codex"].find((id) => settings.models[id]) ?? "default";
}
