export function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function turnFailureText(code: string | undefined): string {
  if (code === "budget_exceeded") return "the session budget was reached. Check today's usage.";
  if (code === "unavailable") return "the model is not configured or unavailable.";
  if (code === "uncertain") return "the provider response could not be confirmed.";
  return "the reply did not complete. Try again.";
}
