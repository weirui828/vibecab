import markSvg from "../assets/brand/vc-mark.svg?raw";

// The cab is the gondola inside the C of the mark, cut from the mark's own outline: cabin, roof and the two rods.
// The outline is read from the brand file, so the cab and the logo can never drift apart.

const outlines = [...markSvg.matchAll(/<path d="([^"]+)" transform="([^"]+)"/g)].map((m) => ({
  d: m[1] ?? "",
  transform: m[2] ?? "",
}));
const ink = outlines[0],
  fan = outlines[1];

/** Where the gondola meets the cable, in the mark's own units, and where its two rods end below that point. */
export const gondola = {
  x: 2657,
  y: 1517,
  rods: [
    [-36, 67],
    [35.5, 49],
  ] as const,
};

/** Drawn once per page; every cab is a `<use>` of it. */
export function GondolaDefs() {
  if (!ink || !fan) return null;
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="vc-gondola-clip">
          <polygon points="2545,1724 2600,1724 2600,1588.6 2716.8,1565.9 2716.8,1676 2780,1692 2780,1724 3023,1724 3023,2297 2545,2297" />
        </clipPath>
        <g id="vc-gondola">
          <path className="vc-cab-glass" d="M2637 1820 L2800 1820 Q2940 1900 2950 2060 L2637 2060Z" />
          <rect className="vc-cab-lit" x="2852" y="2132" width="74" height="40" rx="12" />
          {/* The C closed the cabin on this side; without it, a short post does. */}
          <path className="vc-cab-ink" d="M2962 1998 L3004 1998 L2974 2102 L2950 2102Z" />
          <path className="vc-cab-lit" d={fan.d} transform={fan.transform} />
          <g clipPath="url(#vc-gondola-clip)">
            <path className="vc-cab-ink" d={ink.d} transform={ink.transform} />
          </g>
        </g>
      </defs>
    </svg>
  );
}

/** The transform that puts the gondola's cable point at the origin, `scale` times the mark's size. */
export const gondolaTransform = (scale: number) => `scale(${scale}) translate(${-gondola.x} ${-gondola.y})`;
