import { useEffect, useState } from "react";

// The tundra at this hour: low hills on a horizon, with the sun by day and the moon by night where they would
// be in the sky now. It says the same thing as the greeting beside it, so it is decoration (aria-hidden).

const SUNRISE = 5.5,
  SUNSET = 19.5,
  GROUND = 104;

/** Where the sun or the moon is at `now`: which one, and how far along its arc (0 rising, 0.5 highest, 1 setting). */
export function skyAt(now: Date): { body: "sun" | "moon"; t: number } {
  const hour = now.getHours() + now.getMinutes() / 60;
  if (hour >= SUNRISE && hour < SUNSET) return { body: "sun", t: (hour - SUNRISE) / (SUNSET - SUNRISE) };
  const night = 24 - SUNSET + SUNRISE,
    since = hour >= SUNSET ? hour - SUNSET : hour + 24 - SUNSET;
  return { body: "moon", t: since / night };
}

const stars: Array<[number, number, number]> = [
  [44, 34, 0],
  [98, 14, 1.4],
  [156, 44, 0.6],
  [228, 20, 2.1],
  [286, 50, 1],
  [326, 16, 2.8],
];

export function Horizon({ now: fixed }: { now?: Date }) {
  const [now, setNow] = useState(() => fixed ?? new Date());
  // The sky moves slowly; every few minutes is enough.
  useEffect(() => {
    if (fixed) return;
    const timer = setInterval(() => setNow(new Date()), 5 * 60_000);
    return () => clearInterval(timer);
  }, [fixed]);
  const { body, t } = skyAt(now),
    x = 180 - 140 * Math.cos(Math.PI * t),
    y = GROUND - 12 - 66 * Math.sin(Math.PI * t);
  return (
    <svg className="vc-horizon" data-sky={body} viewBox="0 0 360 120" width="360" height="120" aria-hidden="true">
      <defs>
        <linearGradient id="vc-horizon-ground" x1="0" x2="1" y1="0" y2="0">
          <stop className="edge" offset="0" />
          <stop className="land" offset="0.18" />
          <stop className="land" offset="0.82" />
          <stop className="edge" offset="1" />
        </linearGradient>
      </defs>
      {body === "moon" &&
        stars.map(([sx, sy, delay]) => (
          <circle key={sx} className="star" cx={sx} cy={sy} r="1.1" style={{ animationDelay: `${delay}s` }} />
        ))}
      <g className="body" transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
        <g className="rise">
          <circle className="glow" r="21" />
          {body === "sun" ? (
            <circle className="disc" r="9" />
          ) : (
            <path className="disc" d="M3.5 -9.2A9.6 9.6 0 1 0 9.2 6.4 7.6 7.6 0 0 1 3.5 -9.2Z" />
          )}
        </g>
      </g>
      <path className="hill far" d="M6 104a104 24 0 0 1 208 0Z" />
      <path className="hill far" d="M178 104a84 18 0 0 1 168 0Z" />
      <path className="hill mid" d="M96 104a70 36 0 0 1 140 0Z" />
      <path className="hill near" d="M212 104a44 19 0 0 1 88 0Z" />
      <path className="hill near" d="M44 104a32 12 0 0 1 64 0Z" />
      <path className="hill mark" d="M150 104a13 13 0 0 1 26 0Z" />
      <path className="ground" d="M0 104.5H360" stroke="url(#vc-horizon-ground)" />
    </svg>
  );
}
