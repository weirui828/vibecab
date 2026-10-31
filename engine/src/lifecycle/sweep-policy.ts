export type KernelActivitySnapshot = { leasedJobs: Array<{ id: string; kind: string }>; lastWriteAt: string | null };

const quietWindowMs = 60_000;

export function isQuiet(activity: KernelActivitySnapshot, now: string, sweepJobId: string): boolean {
  if (activity.leasedJobs.some((job) => job.id !== sweepJobId)) return false;
  return activity.lastWriteAt === null || Date.parse(now) - Date.parse(activity.lastWriteAt) >= quietWindowMs;
}

export function nextSweepDeferral(now: string, deferrals: number): string {
  const delay = deferrals === 0 ? 5 * 60_000 : deferrals === 1 ? 15 * 60_000 : 60 * 60_000;
  return new Date(Date.parse(now) + delay).toISOString();
}

export function shouldForceSweep(now: string, deferredSince: string): boolean {
  return Date.parse(now) - Date.parse(deferredSince) >= 24 * 60 * 60_000;
}
