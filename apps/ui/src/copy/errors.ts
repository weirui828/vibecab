const messages: Record<string, string> = {
  unauthenticated: "Sign in to VibeCab again to continue.",
  forbidden: "You do not have permission to do that.",
  not_found: "This item is not available.",
  conflict: "VibeCab cannot do this now. The item changed, or its state does not allow it.",
  stale_base: "This text changed after you started to edit it.",
  budget_exceeded: "You reached the spending limit for today.",
  unavailable: "The engine is not available.",
};

export function errorMessage(code: string): string {
  return messages[code] ?? "VibeCab could not do this. Try again.";
}
