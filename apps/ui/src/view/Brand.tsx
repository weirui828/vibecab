import type { CSSProperties } from "react";
import wordmarkInk from "../assets/brand/wordmark-ink.svg?url";
import wordmarkAccent from "../assets/brand/wordmark-accent.svg?url";
import vcMark from "../assets/brand/vc-mark.svg?url";

// Brand art is drawn as CSS masks so theme tokens tint it in Summer and Polar night.
const mask = (url: string): CSSProperties => ({
  WebkitMaskImage: `url("${url}")`,
  maskImage: `url("${url}")`,
});

export function Wordmark({ width = 176 }: { width?: number }) {
  return (
    <span className="wordmark" role="img" aria-label="VibeCab" style={{ width, height: width / 2.88 }}>
      <span className="wordmark-ink" style={mask(wordmarkInk)} />
      <span className="wordmark-accent" style={mask(wordmarkAccent)} />
    </span>
  );
}

export function Mark({ width = 96 }: { width?: number }) {
  return <span className="brand-mark" aria-hidden="true" style={{ ...mask(vcMark), width, height: width / 1.645 }} />;
}

export type MoundTone = "active" | "attention" | "agent" | "quiet" | "danger";

export function Mound({ tone = "active", label }: { tone?: MoundTone; label?: string }) {
  return (
    <span
      className="mound"
      data-tone={tone}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}

// The empty-state hill row: overlapping tussocks in the tundra palette.
export function Hills() {
  const hills: Array<[number, number, MoundTone | "lichen"]> = [
    [192, 72, "active"],
    [90, 40, "lichen"],
    [140, 96, "quiet"],
    [58, 24, "danger"],
    [114, 48, "lichen"],
  ];
  return (
    <div className="hills" aria-hidden="true">
      {hills.map(([w, h, tone], index) => (
        <span key={index} data-tone={tone} style={{ width: w, height: h }} />
      ))}
    </div>
  );
}
