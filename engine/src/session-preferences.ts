import type { Settings } from "../../contract/src/index.js";

export function sessionPreferences(settings: Settings, sessionId: string): Settings["sessions"][string] {
  return { ...settings.sessions.default, ...settings.sessions[sessionId] };
}

/**
 * The pool agent that works for a session (W13): the session's own choice, else the VibeCab role's agent, else the
 * default model, else any agent in the pool — so one agent of any kind is enough to work with.
 */
export function baseModelRef(settings: Settings, sessionId?: string): string {
  const has = (id: string | undefined): id is string => Boolean(id && settings.models[id]);
  const chosen = sessionId ? sessionPreferences(settings, sessionId)?.agent : undefined;
  if (chosen !== "vibecab" && has(chosen)) return chosen;
  if (has(settings.roles?.vibecab)) return settings.roles.vibecab;
  if (has("default")) return "default";
  return Object.keys(settings.models).sort()[0] ?? "default";
}
