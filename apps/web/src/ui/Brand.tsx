import type { CSSProperties } from "react";
import wordmarkInk from "../assets/brand/wordmark-ink.svg?url";
import wordmarkAccent from "../assets/brand/wordmark-accent.svg?url";
import vcMark from "../assets/brand/vc-mark.svg?url";

// Brand art is drawn as CSS masks so the theme tints it in Summer and Polar night.
const mask = (url: string): CSSProperties => ({ WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")` });

export function Wordmark({ height = 30 }: { height?: number }) {
  return (
    <span className="vc-wordmark" role="img" aria-label="VibeCab" style={{ height, width: height * 2.88 }}>
      <span className="ink" style={mask(wordmarkInk)} />
      <span className="accent" style={mask(wordmarkAccent)} />
    </span>
  );
}

export function Mark({ height = 22 }: { height?: number }) {
  return <span className="vc-mark" aria-hidden="true" style={{ ...mask(vcMark), height, width: height * 1.645 }} />;
}

export type MoundTone = "active" | "attention" | "agent" | "quiet" | "danger";

export function Mound({ tone = "active" }: { tone?: MoundTone }) {
  return <span className="vc-mound" data-tone={tone} aria-hidden="true" />;
}

/** The empty-state hill row: overlapping tussocks. */
export function Hills() {
  return (
    <svg className="vc-hills" width="220" height="64" viewBox="0 0 220 64" aria-hidden="true">
      <path className="h4" d="M150 64a44 44 0 0 1 88 0Z" transform="translate(-26 0)" />
      <path className="h2" d="M18 64a40 40 0 0 1 80 0Z" />
      <path className="h3" d="M118 64a30 30 0 0 1 60 0Z" />
      <path className="h1" d="M62 64a48 48 0 0 1 96 0Z" />
    </svg>
  );
}
