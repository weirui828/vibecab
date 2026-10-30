const messages: Record<string, string> = {
  unauthenticated: "Reconnect to VibeCab to continue.",
  forbidden: "You do not have permission to do that.",
  not_found: "That item is no longer available.",
  conflict: "This changed while you were working.",
  stale_base: "This changed while you were editing.",
  budget_exceeded: "Spending limit reached for today.",
  unavailable: "The engine is unavailable.",
};

export function errorMessage(code: string): string {
  return messages[code] ?? "Something went wrong. Try again.";
}
