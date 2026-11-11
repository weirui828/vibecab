import { createContext, useContext, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useFrame } from "../ui/useFrame.js";

// Wind: now and then one slow gust crosses the app. The plumb line leans and the cabs sway. It is silent.
// Between gusts nothing moves on its own.

/** What everything that sways reads each frame. `level` swells from 0 to 1 and back over one gust. */
export interface Wind {
  level: number;
  /** Seconds on the wind's own clock; `from` is when the current gust began. */
  clock: number;
  from: number;
}

const WindContext = createContext<{ wind: Wind }>({ wind: { level: 0, clock: 0, from: -100 } });
export const useWind = () => useContext(WindContext);

export function WindProvider({ children }: { children: ReactNode }) {
  const wind = useRef<Wind>({ level: 0, clock: 0, from: -100 }).current,
    next = useRef(8),
    long = useRef(7);
  useFrame((dt) => {
    wind.clock += dt;
    if (wind.clock >= next.current) {
      wind.from = wind.clock;
      long.current = 6.5 + Math.random() * 2.5;
      next.current = wind.clock + 24 + Math.random() * 26;
    }
    const part = (wind.clock - wind.from) / long.current;
    wind.level = part > 0 && part < 1 ? Math.sin(Math.PI * part) ** 2 : 0;
  });
  const value = useMemo(() => ({ wind }), [wind]);
  return <WindContext.Provider value={value}>{children}</WindContext.Provider>;
}

/** How far a gust leans a hanging line at `s` (0 top, 1 bottom), in the line's own units: a swell that rolls down it. */
export function lean(wind: Wind, s: number): number {
  if (wind.level === 0) return 0;
  const roll = 0.75 + 0.25 * Math.sin(2 * Math.PI * 1.3 * s - 1.1 * (wind.clock - wind.from));
  return wind.level * Math.sin(Math.PI * s) * roll;
}
