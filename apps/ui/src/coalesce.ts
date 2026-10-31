// Coalesces bursts of refresh requests (event replays, polling) into at most one run in flight
// plus one trailing run, so the single-writer engine is never flooded with duplicate queries.
export function coalesce(run: () => Promise<void>, delayMs = 150) {
  let timer: ReturnType<typeof setTimeout> | undefined,
    running = false,
    again = false,
    stopped = false;
  const fire = async (): Promise<void> => {
    timer = undefined;
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await run();
    } catch {
      // Callers surface their own errors; a failed refresh must not stop later ones.
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => void fire(), delayMs);
  };
  return {
    schedule,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
