export type TrayStatus = { running: boolean; updateTitle?: string; needsYou: number };
export type RecentSession = { sessionId: string; title: string; updatedAt?: string; createdAt?: string };

export function menuStatus(status: TrayStatus): string[] {
  const result = [status.running ? "Engine running" : "Engine stopped"];
  if (status.updateTitle) result.push(`Updating ‘${status.updateTitle}’…`);
  if (status.needsYou > 0) result.push(`${status.needsYou} ${status.needsYou === 1 ? "item needs" : "items need"} you`);
  return result;
}

export function recentSessionItems<T extends RecentSession>(sessions: T[]): T[] {
  return [...sessions]
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""))
    .slice(0, 5);
}
