import { useEffect, useRef } from "react";

/** People who ask for less motion get the resting picture: nothing rides, sways or blows. */
export function prefersCalm(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Calls `tick` once per animation frame with the seconds since the last one and the seconds since it started.
 * It draws once at the start, and again whenever `redrawOn` changes, so the picture is whole and current where
 * frames never come (a hidden tab, a test, a person who asked for less motion).
 */
export function useFrame(tick: (dt: number, clock: number) => void, active = true, redrawOn?: unknown): void {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    latest.current(1 / 60, 0);
  }, [redrawOn]);
  useEffect(() => {
    if (!active || prefersCalm() || typeof window.requestAnimationFrame !== "function") return;
    let frame = 0,
      last = performance.now(),
      clock = 0;
    const loop = (now: number) => {
      // A tab that was away comes back with one long gap: treat it as a single ordinary frame.
      const dt = Math.min(0.034, Math.max(0.001, (now - last) / 1000));
      last = now;
      clock += dt;
      latest.current(dt, clock);
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frame);
  }, [active]);
}
