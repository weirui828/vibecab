import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { attentionSentence } from "../src/home/attentionText.js";
import { relativeTime } from "../src/ui/time.js";

const root = join(import.meta.dirname, "../src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const sources = files(root).filter((path) => /\.(tsx?|css)$/.test(path));

it("never shows engine names as literal JSX text (AGENTS.md §9.2)", () => {
  for (const path of sources.filter((p) => p.endsWith(".tsx"))) {
    const source = readFileSync(path, "utf8");
    // JSX text nodes: between a tag's ">" and the next "<", with no code characters in between.
    expect(source, path).not.toMatch(
      /[^=]>[^<>{}()"=;]*\b(?:artifact|Artifact|OutputSet|vc\.[A-Z][A-Za-z]+)\b[^<>{}()"=;]*</,
    );
  }
});

it("uses design-system tokens only: no raw hex or rgb colours in the web app", () => {
  for (const path of sources) {
    const source = readFileSync(path, "utf8");
    expect(source, path).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![-\w])/);
    expect(source, path).not.toMatch(/\brgba?\(/);
  }
});

it("never renders user or agent text as HTML", () => {
  for (const path of sources) expect(readFileSync(path, "utf8"), path).not.toContain("dangerouslySetInnerHTML");
});

it("writes waiting items as one sentence, most urgent first", () => {
  expect(
    attentionSentence([
      { kind: "agreed_item", id: "a" },
      { kind: "unread_reply", id: "b" },
      { kind: "unread_reply", id: "c" },
      { kind: "conflict", id: "d" },
    ]),
  ).toBe("Two agreed changes conflict, 2 new replies and an agreed change waits for the next update.");
});

it("formats short relative times", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  expect(relativeTime("2026-11-07T11:59:30Z", now)).toBe("just now");
  expect(relativeTime("2026-11-07T11:15:00Z", now)).toBe("45m ago");
  expect(relativeTime("2026-11-07T07:00:00Z", now)).toBe("5h ago");
  expect(relativeTime("2026-11-04T12:00:00Z", now)).toBe("3d ago");
  expect(relativeTime("2026-10-01T12:00:00Z", now)).toBe("Oct 1");
});
