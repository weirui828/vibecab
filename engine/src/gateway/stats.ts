import type { CallLog } from "./types.js";

export type UsageGroupBy = "day" | "agent" | "model" | "session" | "purpose";
export interface UsageTotals {
  calls: number;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  errors: number;
  medianDurationMs: number;
  p95DurationMs: number;
}
export interface UsageStats {
  totals: UsageTotals;
  groups: Array<UsageTotals & { key: string }>;
}

/** Nearest-rank percentile of sorted values; 0 for none. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
}

function total(calls: CallLog[]): UsageTotals {
  const durations = calls.map((c) => c.durationMs ?? 0).sort((a, b) => a - b);
  return {
    calls: calls.length,
    // What was settled; a call whose usage is unknown stays charged at its reservation.
    costMicros: calls.reduce((n, c) => n + (c.settledMicros ?? c.reservedMicros), 0),
    inputTokens: calls.reduce((n, c) => n + (c.inputTokens ?? 0), 0),
    outputTokens: calls.reduce((n, c) => n + (c.outputTokens ?? 0), 0),
    cachedInputTokens: calls.reduce((n, c) => n + (c.cachedInputTokens ?? 0), 0),
    errors: calls.filter((c) => c.errorCode !== undefined).length,
    medianDurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
  };
}

/**
 * Model calls with `from <= createdAt < to`, totalled and grouped. Records from before calls were attributed
 * group under "". Pure: the day of a call comes from `dayOf`, so the budget time zone decides where days end.
 */
export function usageStats(
  calls: CallLog[],
  options: { from: string; to: string; groupBy: UsageGroupBy; dayOf(iso: string): string },
): UsageStats {
  const from = Date.parse(options.from),
    to = Date.parse(options.to);
  const inRange = calls.filter((c) => {
    const at = Date.parse(c.createdAt);
    return at >= from && at < to;
  });
  const keyOf = (c: CallLog): string =>
    options.groupBy === "day"
      ? options.dayOf(c.createdAt)
      : options.groupBy === "agent"
        ? (c.agentId ?? "")
        : options.groupBy === "model"
          ? c.model
          : options.groupBy === "session"
            ? (c.sessionId ?? "")
            : (c.purpose ?? "");
  const byKey = new Map<string, CallLog[]>();
  for (const c of inRange) byKey.set(keyOf(c), [...(byKey.get(keyOf(c)) ?? []), c]);
  return {
    totals: total(inRange),
    groups: [...byKey.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, group]) => ({ key, ...total(group) })),
  };
}
