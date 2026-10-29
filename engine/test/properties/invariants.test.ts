import { expect, it } from "vitest";
import fc from "fast-check";
import { contentFixture } from "../content-fixture.js";
import { paragraph } from "../helpers.js";
import type { CommitInput, Element, ElementDraft } from "../../../contract/src/index.js";
import { importContent, outlineMarkdown } from "../../src/content/import.js";
import { diffVersions } from "../../src/content/diff.js";
const runs = Number(process.env.FC_NUM_RUNS ?? 100);
const options = { numRuns: runs, verbose: true };
const text = fc.stringMatching(/^[a-zA-Z0-9 ]{1,40}$/);
const trees = fc.array(fc.record({ text, nested: fc.boolean() }), {
  minLength: 1,
  maxLength: 8,
});
function seedTree(
  f: ReturnType<typeof contentFixture>,
  tree: {
    text: string;
    nested: boolean;
  }[],
) {
  const changes: CommitInput["changes"] = [];
  for (const [i, node] of tree.entries()) {
    const tempId = "new:" + i * 3;
    if (node.nested) {
      changes.push(
        {
          op: "add",
          tempId,
          parentId: null,
          element: { type: "list", props: { ordered: false } },
        },
        {
          op: "add",
          tempId: "new:" + (i * 3 + 1),
          parentId: tempId,
          element: { type: "list_item", props: {}, text: node.text },
        },
      );
    } else
      changes.push({
        op: "add",
        tempId,
        parentId: null,
        element: paragraph(node.text),
      });
  }
  return f.commit({ baseVersion: 1, changes });
}
it("untouched means untouched for random trees and write sets", () =>
  fc.assert(
    fc.asyncProperty(trees, fc.array(fc.nat(), { maxLength: 8 }), async (tree, picks) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const f = contentFixture();
      try {
        seedTree(f, tree);
        const old = f.store.version(f.artifactId, 2),
          elements = f.store.elements(f.artifactId, 2),
          selected = new Set(picks.map((i) => elements[i % elements.length]!.elementId));
        const changes: CommitInput["changes"] = elements
          .filter((e) => selected.has(e.elementId))
          .map((e) => ({
            op: "update",
            elementId: e.elementId,
            element: draft(e, "updated"),
          }));
        const committed = f.commit({ baseVersion: 2, changes }),
          next = f.store.version(f.artifactId, committed.version);
        for (const [id, hash] of Object.entries(old.manifest))
          if (!selected.has(id)) expect(next.manifest[id]).toBe(hash);
      } finally {
        f.store.close();
      }
    }),
    options,
  ));
function draft(e: Element, text: string): ElementDraft {
  const { elementId: _, parentId: __, order: ___, ...d } = e;
  void _;
  void __;
  void ___;
  return "text" in d ? { ...d, text } : d.type === "list" ? { ...d, props: { ordered: !d.props.ordered } } : d;
}
it("staleness rejects iff independent valid writes overlap", () =>
  fc.assert(
    fc.asyncProperty(trees, fc.nat(), fc.nat(), async (tree, a, b) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const f = contentFixture();
      try {
        seedTree(f, tree);
        const elements = f.store.elements(f.artifactId, 2),
          one = elements[a % elements.length]!,
          two = elements[b % elements.length]!;
        f.commit({
          baseVersion: 2,
          changes: [
            {
              op: "update",
              elementId: one.elementId,
              element: draft(one, "first changed"),
            },
          ],
        });
        const second = () =>
          f.commit({
            baseVersion: 2,
            changes: [
              {
                op: "update",
                elementId: two.elementId,
                element: draft(two, "second changed"),
              },
            ],
          });
        if (one.elementId === two.elementId)
          expect(second).toThrow(
            expect.objectContaining({
              contract: expect.objectContaining({ code: "stale_base" }),
            }),
          );
        else expect(second).not.toThrow();
      } finally {
        f.store.close();
      }
    }),
    options,
  ));
it("random moves and adds never create invalid parents", () =>
  fc.assert(
    fc.asyncProperty(trees, fc.nat(), fc.nat(), fc.boolean(), async (tree, a, b, toRoot) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const f = contentFixture();
      try {
        seedTree(f, tree);
        const elements = f.store.elements(f.artifactId, 2),
          child = elements[a % elements.length]!,
          parent = elements[b % elements.length]!;
        try {
          const parentId = toRoot ? null : parent.elementId;
          const element: ElementDraft = toRoot
            ? paragraph("Added")
            : parent.type === "list"
              ? { type: "list_item", props: {}, text: "Added" }
              : parent.type === "list_item"
                ? { type: "list", props: { ordered: false } }
                : paragraph("Added");
          f.commit({
            baseVersion: 2,
            changes: [
              { op: "move", elementId: child.elementId, parentId },
              { op: "add", tempId: "new:100", parentId, element },
            ],
          });
        } catch (error) {
          expect(error).toMatchObject({ contract: { code: "conflict" } });
        }
        expect(() =>
          f.content.validateTree(f.store.elements(f.artifactId, f.store.artifact(f.artifactId).headVersion)),
        ).not.toThrow();
      } finally {
        f.store.close();
      }
    }),
    options,
  ));
it("IDs never repeat or retain temp IDs across removal and insertion", () =>
  fc.assert(
    fc.asyncProperty(fc.array(text, { minLength: 1, maxLength: 10 }), async (values) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const f = contentFixture(),
        seen = new Set<string>();
      try {
        let version = 1;
        for (const value of values) {
          const current = f.store.elements(f.artifactId, version);
          const r = f.commit({
            baseVersion: version,
            changes: [
              ...current.filter((e) => e.parentId === null).map((e) => ({ op: "remove", elementId: e.elementId })),
              {
                op: "add",
                tempId: "new:0",
                parentId: null,
                element: paragraph(value),
              },
            ],
          });
          version = r.version;
          const id = r.idMap["new:0"]!;
          expect(seen.has(id)).toBe(false);
          expect(id).toMatch(/^el_/);
          seen.add(id);
          expect(Object.keys(f.store.version(f.artifactId, version).manifest).some((id) => id.startsWith("new:"))).toBe(
            false,
          );
        }
      } finally {
        f.store.close();
      }
    }),
    options,
  ));
it("restore reproduces the manifest and extends history", () =>
  fc.assert(
    fc.asyncProperty(trees, async (tree) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const f = contentFixture();
      try {
        seedTree(f, tree);
        const old = f.store.version(f.artifactId, 2);
        f.commit({
          baseVersion: 2,
          changes: [
            {
              op: "add",
              tempId: "new:100",
              parentId: null,
              element: paragraph("Later"),
            },
          ],
        });
        f.store.transaction(() => f.content.restore(f.artifactId, 2, { kind: "human" }));
        expect(f.store.version(f.artifactId, 4).manifest).toEqual(old.manifest);
        expect(f.store.versions(f.artifactId)).toHaveLength(4);
      } finally {
        f.store.close();
      }
    }),
    options,
  ));
it("diff partitions reproduce the target manifest", () =>
  fc.assert(
    fc.asyncProperty(trees, text, async (tree, value) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const f = contentFixture();
      try {
        seedTree(f, tree);
        const elements = f.store.elements(f.artifactId, 2),
          first = elements[0]!;
        const roots = elements.filter((e) => e.parentId === null);
        const changes: CommitInput["changes"] = [
          {
            op: "update",
            elementId: first.elementId,
            element: draft(first, value),
          },
        ];
        if (roots[1]) changes.push({ op: "remove", elementId: roots[1].elementId });
        if (roots[2])
          changes.push({
            op: "move",
            elementId: first.elementId,
            parentId: null,
            after: roots[2].elementId,
          });
        changes.push({
          op: "add",
          tempId: "new:100",
          parentId: null,
          element: paragraph("Added"),
        });
        f.commit({ baseVersion: 2, changes });
        const from = f.store.version(f.artifactId, 2),
          to = f.store.version(f.artifactId, 3),
          diff = diffVersions(f.store, f.artifactId, 2, 3),
          manifest = { ...from.manifest };
        for (const id of diff.removed) delete manifest[id];
        for (const id of new Set([...diff.added, ...diff.changed, ...diff.moved])) manifest[id] = to.manifest[id]!;
        expect(manifest).toEqual(to.manifest);
      } finally {
        f.store.close();
      }
    }),
    options,
  ));
it("import outline reimport preserves types and text", () =>
  fc.assert(
    fc.asyncProperty(fc.array(text, { minLength: 1, maxLength: 6 }), async (texts) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const markdown =
        "# Heading\n\n" +
        texts.map((t) => "- " + t.trim()).join("\n") +
        "\n\n> Quote\n\n```ts\nlet x = 1;\n```\n\n| A | B |\n| --- | --- |\n| C | D |";
      const first = importContent(markdown, "markdown"),
        second = importContent(outlineMarkdown(first), "markdown");
      expect(second.map((n) => n.element)).toEqual(first.map((n) => n.element));
    }),
    options,
  ));
