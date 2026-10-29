import { describe, it, expect } from "vitest";
import { contentFixture } from "./content-fixture.js";
import { paragraph } from "./helpers.js";
import { resolveAnchors, diffVersions } from "../src/content/diff.js";
import { Contract, inlineText } from "../../contract/src/index.js";
import { importContent } from "../src/content/import.js";
import { revisionHash } from "../src/content/hash.js";
describe("anchors and diff", () => {
  it("distinguishes unchanged, revised, uniquely contextualized, ambiguous, and removed anchors", () => {
    const f = contentFixture();
    try {
      const r = f.commit({
        baseVersion: 1,
        changes: [
          {
            op: "add",
            tempId: "new:0",
            parentId: null,
            element: paragraph("before quote after"),
          },
        ],
      });
      const id = r.idMap["new:0"]!,
        seen = f.store.version(f.artifactId, 2);
      const anchor = {
        artifactId: f.artifactId,
        elementId: id,
        seenVersion: 2,
        seenHash: seen.manifest[id]!,
        locator: { quote: "quote", prefix: "before ", suffix: " after" },
      };
      expect(resolveAnchors(f.store, [anchor])[0]).toMatchObject({
        state: "current",
      });
      f.commit({
        baseVersion: 2,
        changes: [
          {
            op: "update",
            elementId: id,
            element: paragraph("new before quote after and quote"),
          },
        ],
      });
      expect(resolveAnchors(f.store, [anchor])[0]).toMatchObject({
        state: "revised",
        range: { start: 11, end: 16 },
      });
      f.commit({
        baseVersion: 3,
        changes: [
          {
            op: "update",
            elementId: id,
            element: paragraph("new quote location"),
          },
        ],
      });
      expect(resolveAnchors(f.store, [anchor])[0]).toMatchObject({
        state: "revised",
        range: { start: 4, end: 9 },
      });
      f.commit({
        baseVersion: 4,
        changes: [
          { op: "update", elementId: id, element: paragraph("quote quote") },
        ],
      });
      expect(resolveAnchors(f.store, [anchor])[0]).toEqual({
        anchor,
        state: "revised",
      });
      f.commit({ baseVersion: 5, changes: [{ op: "remove", elementId: id }] });
      expect(resolveAnchors(f.store, [anchor])[0]).toEqual({
        anchor,
        state: "removed",
      });
    } finally {
      f.store.close();
    }
  });
  it("reports pure moves separately and gives word-level changes", () => {
    const f = contentFixture();
    try {
      const r = f.commit({
        baseVersion: 1,
        changes: [
          {
            op: "add",
            tempId: "new:0",
            parentId: null,
            element: paragraph("one two"),
          },
          {
            op: "add",
            tempId: "new:1",
            parentId: null,
            element: paragraph("other"),
          },
        ],
      });
      const id = r.idMap["new:0"]!,
        other = r.idMap["new:1"]!;
      f.commit({
        baseVersion: 2,
        changes: [{ op: "move", elementId: id, parentId: null, after: other }],
      });
      expect(diffVersions(f.store, f.artifactId, 2, 3)).toMatchObject({
        moved: [id],
        changed: [],
      });
      f.commit({
        baseVersion: 3,
        changes: [
          { op: "update", elementId: id, element: paragraph("one three") },
        ],
      });
      const d = diffVersions(f.store, f.artifactId, 3, 4);
      expect(d.changed).toEqual([id]);
      expect(d.textDiffs[id]).toEqual(
        expect.arrayContaining([
          { value: "two", removed: true },
          { value: "three", added: true },
        ]),
      );
    } finally {
      f.store.close();
    }
  });
});
describe("doc schemas and Markdown import", () => {
  const contract = new Contract();
  it("accepts every block kind, nested lists, tables, literal code, and image links without fetching", () => {
    const markdown =
      "# Heading\n\nText **bold** and *italic* and `code` and [link](https://example.com)\n\n- Item\n  - Nested\n\n> Quote\n\n```js\n<script>raw</script>\n```\n\n| A | B |\n|---|---|\n| C | D |\n\n---\n\n![Alt](https://example.com/image.png)\n\n<b>HTML</b>\n\n~~deleted~~";
    const nodes = importContent(markdown, "markdown");
    for (const n of nodes)
      expect(() => contract.read("element-draft", n.element)).not.toThrow();
    expect(nodes.map((n) => n.element.type)).toEqual(
      expect.arrayContaining([
        "heading",
        "paragraph",
        "list",
        "list_item",
        "quote",
        "code_block",
        "table",
        "table_row",
        "table_cell",
        "divider",
      ]),
    );
    expect(
      nodes.some(
        (n) =>
          n.element.type === "paragraph" &&
          n.element.text === "[Alt](https://example.com/image.png)",
      ),
    ).toBe(true);
  });
  it("rejects illegal formatting and structural relationships", () => {
    for (const text of [
      "# Heading",
      "<b>html</b>",
      "![alt](url)",
      "~~strike~~",
      "**unclosed",
      "[broken]",
    ])
      expect(inlineText(text)).toBe(false);
    const element = {
      elementId: "el_00000000000000000000000001",
      parentId: null,
      order: "a0",
      type: "table_cell",
      props: {},
      text: "Cell",
    };
    expect(() => contract.read("doc-tree", [element])).toThrow();
    expect(() =>
      contract.read("element", {
        ...element,
        type: "heading",
        props: { level: 7 },
      }),
    ).toThrow();
  });
  it("accepts nested emphasis and literal syntax inside code while rejecting HTML", () => {
    for (const text of [
      "**bold *italic***",
      "*italic **bold***",
      "`<b>literal</b>`",
      "\\<b>literal\\</b>",
      "`~~literal~~`",
    ])
      expect(inlineText(text), text).toBe(true);
  });
  it("hashes canonical JSON independent of property insertion order", () => {
    const a = contract.read<import("../../contract/src/index.js").Element>(
      "element",
      {
        elementId: "el_00000000000000000000000001",
        parentId: null,
        order: "a0",
        type: "paragraph",
        props: {},
        text: "Text",
      },
    );
    const b = contract.read<import("../../contract/src/index.js").Element>(
      "element",
      {
        text: "Text",
        props: {},
        type: "paragraph",
        order: "a0",
        parentId: null,
        elementId: a.elementId,
      },
    );
    expect(revisionHash(a)).toBe(revisionHash(b));
  });
});
