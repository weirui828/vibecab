import { expect, it } from "vitest";
import { purgeSentence } from "../src/home/TrashView.js";
import { fileName } from "../src/session/ExportDialog.js";
import { versionOrigin } from "../src/session/HistorySheet.js";

const preview = (counts: Record<string, number>) =>
  ({
    target: {},
    recordIds: [],
    revisionHashes: Array(counts.revisionHashes ?? 0).fill("h"),
    blobHashes: Array(counts.blobHashes ?? 0).fill("b"),
    manifestIds: [],
    digestIds: Array(counts.digestIds ?? 0).fill("d"),
    commentIds: Array(counts.commentIds ?? 0).fill("c"),
    agreementIds: [],
    updateIds: [],
    conflictIds: [],
    outputSetIds: Array(counts.outputSetIds ?? 0).fill("o"),
    reviewRuns: [],
  }) as Parameters<typeof purgeSentence>[0][number];

it("says what a purge removes in one sentence, summed over everything", () => {
  expect(
    purgeSentence([preview({ revisionHashes: 14, blobHashes: 3 }), preview({ commentIds: 22, digestIds: 2 })]),
  ).toBe("This removes 14 pieces of text history, 22 comments, 3 images and 2 summaries. It cannot be undone.");
  expect(purgeSentence([preview({ outputSetIds: 1 })])).toBe("This removes 1 snapshot. It cannot be undone.");
  expect(purgeSentence([preview({})])).toBe("This removes it for good. It cannot be undone.");
});

it("says how each version came to be", () => {
  const v = (version: number, source: Record<string, unknown>) =>
    ({ version, source, createdBy: { kind: "human" } }) as Parameters<typeof versionOrigin>[0];
  expect(versionOrigin(v(1, { importId: "i" }))).toBe("Imported");
  expect(versionOrigin(v(2, { importId: "i" }))).toBe("Added from a file");
  expect(versionOrigin(v(3, { updateId: "u" }))).toBe("Update by the agent for you");
  expect(versionOrigin(v(4, { restoreOf: 1 }))).toBe("Restored from version 1");
  expect(versionOrigin(v(5, { editId: "e" }))).toBe("Your edit");
});

it("names export files after their titles, safely", () => {
  expect(fileName("Launch notes", "markdown")).toBe("Launch-notes.md");
  expect(fileName("../../etc/passwd", "html")).toBe("etc-passwd.html");
  expect(fileName("草稿 一", "json")).toBe("草稿-一.json");
  expect(fileName("???", "markdown")).toBe("vibecab-export.md");
});
