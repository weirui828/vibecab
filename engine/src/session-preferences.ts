import type { Settings } from "../../contract/src/index.js";

export function sessionPreferences(settings: Settings, sessionId: string): Settings["sessions"][string] {
  return { ...settings.sessions.default, ...settings.sessions[sessionId] };
}
