import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { gondolaTransform } from "../ui/Gondola.js";
import { skyAt } from "../ui/Horizon.js";
import { useFrame } from "../ui/useFrame.js";

// The tundra at this hour, wide: hills, the sun or the moon where it would be now, and far off one cab crossing
// the valley. It says nothing the greeting does not, so it is decoration (aria-hidden).

const FAR: Array<[number, number, number, number, number]> = [
  // x0, y0, x1, y1, how far the span dips in the middle
  [560, 112, 700, 97, 3.5],
  [700, 97, 1010, 79, 8],
  [1010, 79, 1220, 70, 3.5],
];
const farCable = FAR.map(
  ([x0, y0, x1, y1, dip], i) => `${i ? "" : `M${x0} ${y0}`}Q${(x0 + x1) / 2} ${(y0 + y1) / 2 + dip} ${x1} ${y1}`,
).join("");

export function HomeScene({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => new Date()),
    cab = useRef<SVGGElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 5 * 60_000);
    return () => clearInterval(timer);
  }, []);
  useFrame((_dt, clock) => {
    const x = 560 + 660 * ((0.4 + clock / 40) % 1),
      [x0, y0, x1, y1, dip] = FAR.find((span) => x <= span[2]) ?? FAR[2]!,
      u = (x - x0) / (x1 - x0),
      // The same curve the far cable is drawn with, so the cab stays on it.
      y = (1 - u) ** 2 * y0 + 2 * u * (1 - u) * ((y0 + y1) / 2 + dip) + u * u * y1;
    cab.current?.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
  });
  const { body, t } = skyAt(now),
    x = 820 - 300 * Math.cos(Math.PI * t),
    y = 150 - 96 * Math.sin(Math.PI * t);
  return (
    <header className="vc-scene vc-home-scene" data-sky={body}>
      <svg viewBox="0 0 1200 240" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <g className="vc-stars">
          <circle cx="140" cy="40" r="1.6" />
          <circle cx="470" cy="22" r="1.3" style={{ animationDelay: "1s" }} />
          <circle cx="760" cy="50" r="1.6" style={{ animationDelay: "2s" }} />
          <circle cx="1040" cy="30" r="1.3" style={{ animationDelay: "0.5s" }} />
        </g>
        <path className="vc-aurora a1" d="M-40 70 C 200 10, 420 110, 660 46 S 1040 30, 1260 84" />
        <path className="vc-aurora a2" d="M-40 104 C 240 50, 460 136, 720 80 S 1060 70, 1260 116" />
        <g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
          <circle className="vc-orb-glow" r="44" />
          {body === "sun" ? (
            <circle className="vc-orb" r="18" />
          ) : (
            <path className="vc-orb" transform="scale(1.8)" d="M3.5 -9.2A9.6 9.6 0 1 0 9.2 6.4 7.6 7.6 0 0 1 3.5 -9.2Z" />
          )}
        </g>
        <path className="vc-hill far" d="M0 160 Q 150 84 330 140 T 640 122 T 930 114 T 1200 148 V240 H0Z" />
        <path className="vc-far-line" d={`M560 112V160M700 96V150M1010 78V140${farCable}`} />
        <g ref={cab} className="vc-far-cab">
          <use href="#vc-gondola" transform={`translate(0 -1.9) ${gondolaTransform(0.034)}`} />
        </g>
        <path className="vc-hill mid" d="M0 196 Q 200 124 420 180 T 800 162 T 1200 184 V240 H0Z" />
        <path className="vc-hill near" d="M0 222 Q 260 176 520 218 T 1200 210 V240 H0Z" />
      </svg>
      <div className="vc-hello">{children}</div>
    </header>
  );
}
