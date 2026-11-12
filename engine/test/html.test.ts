import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parse, serialize } from "parse5";
import { Contract, htmlPlainText, isOneHtmlElement } from "../../contract/src/index.js";
import type { Element } from "../../contract/src/index.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import { Content } from "../src/content/content.js";
import { htmlDocument, importHtml } from "../src/content/index.js";
import { outline } from "../src/content/index.js";
import { renderMarkdown } from "../src/lifecycle/render.js";
import { clock, ctx, fixture, ids } from "./helpers.js";

// Task H1: an HTML file is a Draft as it is. Its wrappers, markup, styles and scripts survive; it is one kind.

const page = `<!doctype html>
<html lang="en" data-theme="x">
<head><meta charset="utf-8"><title>Field  report</title><style>p{color:teal}</style><script>window.a=1</script></head>
<body class="wide">
<!-- a note for the author -->
<main class="page" id="top">
  <h1 class="big">Field report</h1>
  <section class="cards"><p>First <b>finding</b>.</p><p>Second finding.</p></section>
  <div class="row"><span>inline</span> and words</div>
  <table><tr><td>1</td></tr></table>
  <script>document.title = "x"</script>
</main>
loose words
</body></html>`;

function htmlFixture(source = page, title?: string) {
  const contract = new Contract(),
    store = new SqliteStore(":memory:", contract),
    content = new Content(store, contract, clock, ids());
  const made = store.transaction(() =>
    content.import({ format: "html", content: source, ...(title ? { title } : {}) }, { kind: "human" }),
  );
  return { contract, store, content, ...made, elements: () => store.elements(made.artifactId) };
}
/** The elements as the file has them: each parent before its children, siblings in order. */
function inOrder(elements: Element[], parentId: string | null = null): Element[] {
  return elements
    .filter((e) => e.parentId === parentId)
    .sort((a, b) => (a.order < b.order ? -1 : 1))
    .flatMap((e) => [e, ...inOrder(elements, e.elementId)]);
}
const typed = <T extends Element["type"]>(elements: Element[], type: T) =>
  inOrder(elements).filter((e): e is Extract<Element, { type: T }> => e.type === type);

/** The source as a browser reads it, without what the import leaves out by rule: comments and blank text between blocks. */
function normal(source: string): string {
  return serialize(parse(source))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

describe("html in the contract", () => {
  const contract = new Contract();
  it("takes exactly one element as a block, and nothing beside it", () => {
    expect(isOneHtmlElement("<p>One</p>")).toBe(true);
    expect(isOneHtmlElement('<section class="a"><p>One</p><p>Two</p></section>')).toBe(true);
    expect(isOneHtmlElement("<script>let a = '</p>'</script>")).toBe(true);
    for (const bad of [
      "",
      "words",
      "<p>One</p><p>Two</p>",
      "<p>One</p> tail",
      "<!-- only -->",
      "<body><p>x</p></body>x",
    ])
      expect(isOneHtmlElement(bad), bad).toBe(false);
    const draft = (html: string) => ({ type: "html_block", props: {}, html });
    expect(() => contract.read("element-draft", draft("<p>Fine</p>"))).not.toThrow();
    expect(() => contract.read("element-draft", draft("<p>One</p><p>Two</p>"))).toThrow();
  });
  it("reads a block as the words a person sees", () => {
    expect(htmlPlainText("<p>First <b>finding</b>.\n  More</p>")).toBe("First finding . More");
    expect(htmlPlainText("<div><style>p{}</style><script>x()</script><p>Seen</p></div>")).toBe("Seen");
  });
  it("keeps doc and html element types apart, a head single and top-level, and nodes for html only", () => {
    const id = (n: number) => "el_" + String(n).padStart(26, "0");
    const head = {
        elementId: id(1),
        type: "html_head",
        parentId: null,
        order: "a0",
        props: { htmlAttrs: [], bodyAttrs: [] },
        html: "",
      },
      node = { elementId: id(2), type: "html_node", parentId: null, order: "a1", props: { tag: "main", attrs: [] } },
      block = { elementId: id(3), type: "html_block", parentId: id(2), order: "a0", props: {}, html: "<p>x</p>" },
      para = { elementId: id(4), type: "paragraph", parentId: null, order: "a2", props: {}, text: "x" };
    expect(() => contract.read("doc-tree", [head, node, block])).not.toThrow();
    expect(() => contract.read("doc-tree", [head, node, block, para])).toThrow();
    expect(() => contract.read("doc-tree", [head, { ...head, elementId: id(5), order: "a5" }])).toThrow();
    expect(() => contract.read("doc-tree", [node, { ...head, parentId: id(2) }])).toThrow();
    expect(() => contract.read("doc-tree", [node, { ...para, parentId: id(2) }])).toThrow();
    expect(() => contract.read("doc-tree", [para, { ...block, parentId: id(4) }])).toThrow();
  });
});

describe("importing an HTML file", () => {
  it("makes an html Draft: wrappers are nodes, blocks keep their markup, the head is kept whole", () => {
    const f = htmlFixture();
    try {
      expect(f.store.artifact(f.artifactId)).toMatchObject({
        mediaKind: "html",
        title: "Field report",
        headVersion: 1,
      });
      const elements = f.elements(),
        [head] = typed(elements, "html_head"),
        nodes = typed(elements, "html_node"),
        blocks = typed(elements, "html_block").map((b) => b.html);
      expect(head?.props).toEqual({
        htmlAttrs: [
          ["lang", "en"],
          ["data-theme", "x"],
        ],
        bodyAttrs: [["class", "wide"]],
      });
      expect(head?.html).toContain("<style>p{color:teal}</style><script>window.a=1</script>");
      expect(head?.parentId).toBeNull();
      // main and the section only group blocks; the row has words of its own, so it is one block.
      expect(nodes.map((n) => [n.props.tag, n.props.attrs])).toEqual([
        [
          "main",
          [
            ["class", "page"],
            ["id", "top"],
          ],
        ],
        ["section", [["class", "cards"]]],
      ]);
      expect(blocks).toEqual([
        '<h1 class="big">Field report</h1>',
        "<p>First <b>finding</b>.</p>",
        "<p>Second finding.</p>",
        '<div class="row"><span>inline</span> and words</div>',
        "<table><tbody><tr><td>1</td></tr></tbody></table>",
        '<script>document.title = "x"</script>',
        "<span>\nloose words\n</span>",
      ]);
      // The section sits inside main, and its two paragraphs inside it.
      const [main, section] = nodes;
      expect(section?.parentId).toBe(main?.elementId);
      expect(elements.filter((e) => e.parentId === section?.elementId)).toHaveLength(2);
      expect(outline(elements).find((n) => n.type === "html_node")?.children[0]?.preview).toBe("Field report");
      expect(renderMarkdown(elements)).toContain("First finding .");
    } finally {
      f.store.close();
    }
  });
  it("splits a wrapper that mixes links, loose words and blocks, so each part can be commented on", () => {
    // A page as assistants write them: one wrapper around everything, with a link and some words among the blocks.
    const f = htmlFixture(
      `<!doctype html><title>T</title><body><div class="container"><a class="logo" href="#top">Home</a>
        <h1>Report</h1> Written <em>today</em> by hand. <p>First.</p><div class="card"><h3>Card</h3><p>In a card.</p>
        <button>More</button></div><br><small>The end</small></div></body>`,
    );
    try {
      const elements = f.elements();
      expect(typed(elements, "html_node").map((n) => [n.props.tag, n.props.attrs])).toEqual([
        ["div", [["class", "container"]]],
        ["div", [["class", "card"]]],
      ]);
      expect(typed(elements, "html_block").map((b) => b.html)).toEqual([
        '<a class="logo" href="#top">Home</a>',
        "<h1>Report</h1>",
        // Words and inline marks that stand together between blocks stay together, in the plainest wrapper.
        "<span> Written <em>today</em> by hand. </span>",
        "<p>First.</p>",
        "<h3>Card</h3>",
        "<p>In a card.</p>",
        "<button>More</button>",
        "<span><br><small>The end</small></span>",
      ]);
      // Nothing is lost: every word of the page is in some block.
      const words = typed(elements, "html_block")
        .map((b) => htmlPlainText(b.html))
        .join(" ");
      for (const word of ["Home", "Report", "Written", "today", "First.", "Card", "In a card.", "More", "The end"])
        expect(words).toContain(word);
    } finally {
      f.store.close();
    }
  });
  it("takes the title it is given before the file's own, and Untitled when there is none", () => {
    const named = htmlFixture(page, "Mine"),
      bare = htmlFixture("<p>Just this</p>");
    try {
      expect(named.store.artifact(named.artifactId).title).toBe("Mine");
      expect(bare.store.artifact(bare.artifactId).title).toBe("Untitled");
      expect(typed(bare.elements(), "html_block").map((b) => b.html)).toEqual(["<p>Just this</p>"]);
    } finally {
      named.store.close();
      bare.store.close();
    }
  });
  it("starts a Draft and is never poured into another, of either kind", () => {
    const f = htmlFixture();
    try {
      const into = (artifactId: string, format: "html" | "markdown") =>
        f.store.transaction(() => f.content.import({ artifactId, format, content: "<p>More</p>" }, { kind: "human" }));
      expect(() => into(f.artifactId, "html")).toThrow("HTML starts a new Draft");
      // Markdown blocks may not join an html tree.
      expect(() => into(f.artifactId, "markdown")).toThrow();
      expect(f.store.artifact(f.artifactId).headVersion).toBe(1);
    } finally {
      f.store.close();
    }
  });
  it("comes back as the same file, with the blocks in place", () => {
    const f = htmlFixture();
    try {
      const out = htmlDocument(f.elements());
      expect(out.match(/<!doctype html>/gi)).toHaveLength(1);
      expect(normal(out)).toBe(normal(page.replace("loose words", "<span>\nloose words\n</span>")));
    } finally {
      f.store.close();
    }
  });
});

describe("changing an html Draft", () => {
  it("leaves every other element's revision as it was when one block is rewritten (invariant 6)", () => {
    const f = htmlFixture();
    try {
      const before = f.store.version(f.artifactId, 1),
        target = typed(f.elements(), "html_block")[1]!;
      const commit = (html: string) =>
        f.store.transaction(() =>
          f.content.commit({
            artifactId: f.artifactId,
            baseVersion: f.store.artifact(f.artifactId).headVersion,
            changes: [{ op: "update", elementId: target.elementId, element: { type: "html_block", props: {}, html } }],
            createdBy: { kind: "human" },
            source: {},
          }),
        );
      const result = commit('<p class="lead">First finding, said plainly.</p>');
      expect(result.writeSet).toEqual([target.elementId]);
      const after = f.store.version(f.artifactId, 2);
      for (const [id, hash] of Object.entries(before.manifest))
        if (id === target.elementId) expect(after.manifest[id]).not.toBe(hash);
        else expect(after.manifest[id]).toBe(hash);
      expect(Object.keys(after.manifest).sort()).toEqual(Object.keys(before.manifest).sort());
      // A writer that returns two elements for one block, or loose words, is refused and nothing changes.
      for (const bad of ["<p>One</p><p>Two</p>", "just words", "<p>One</p> and a tail"])
        expect(() => commit(bad)).toThrow();
      expect(f.store.artifact(f.artifactId).headVersion).toBe(2);
      expect(htmlDocument(f.elements())).toContain('<p class="lead">First finding, said plainly.</p>');
    } finally {
      f.store.close();
    }
  });
  it("lets the Update writer's output carry html blocks, checked like any element", () => {
    const contract = new Contract(),
      write = (html: string) => ({
        changes: [
          { op: "update", elementId: "el_" + "0".repeat(26), element: { type: "html_block", props: {}, html } },
        ],
        itemResults: [],
      });
    expect(() => contract.read("update-write", write("<h2>Shorter</h2>"))).not.toThrow();
    expect(() => contract.read("update-write", write("<h2>Shorter</h2><p>and more</p>"))).toThrow();
  });
});

// Words, attributes and nesting a real page has, in shapes the importer must not confuse.
const word = fc.constantFrom("moss", "basalt", "a < b", "R&D", "“quoted”", "x");
const leaf = fc.oneof(
  word.map((w) => `<p>${w.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p>`),
  word.map((w) => `<h2 class="t">${w.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</h2>`),
  fc.constant("<ul><li>one</li><li>two</li></ul>"),
  fc.constant("<pre>  keep\n   this</pre>"),
  fc.constant("<hr>"),
  fc.constant('<div class="mixed">words <em>and</em> more</div>'),
  fc.constant("<style>.a{b:c}</style>"),
);
const tree: fc.Arbitrary<string> = fc.letrec((tie) => ({
  group: fc
    .tuple(fc.constantFrom("div", "section", "article", "main"), fc.array(tie("any"), { minLength: 1, maxLength: 4 }))
    .map(([tag, children]) => `<${tag} class="g">${children.join("\n")}</${tag}>`),
  any: fc.oneof({ depthSize: "small" }, leaf, tie("group")),
})).any as fc.Arbitrary<string>;
const documents = fc
  .array(tree, { minLength: 1, maxLength: 6 })
  .map(
    (blocks) =>
      `<!doctype html><html lang="en"><head><title>T</title><style>p{}</style></head><body id="b">${blocks.join("\n")}</body></html>`,
  );

describe("html properties", () => {
  it("imports and exports any generated page to the same page, and a second pass changes nothing", () => {
    fc.assert(
      fc.property(documents, (source) => {
        const once = htmlFixture(source);
        try {
          const out = htmlDocument(once.elements());
          expect(normal(out)).toBe(normal(source));
          const twice = htmlFixture(out);
          try {
            expect(twice.elements().map((e) => [e.type, "html" in e ? e.html : e.props])).toEqual(
              once.elements().map((e) => [e.type, "html" in e ? e.html : e.props]),
            );
            expect(htmlDocument(twice.elements())).toBe(out);
          } finally {
            twice.store.close();
          }
          // Every block the import made is one element, as the contract demands of a block.
          for (const change of importHtml(source).changes)
            if (change.element.type === "html_block") expect(isOneHtmlElement(change.element.html)).toBe(true);
        } finally {
          once.store.close();
        }
      }),
      { numRuns: Number(process.env.FC_NUM_RUNS ?? 60) },
    );
  });
});

describe("html through the engine", () => {
  it("imports with vc.ImportContent, lists the kind, and exports one html Draft as its own file", async () => {
    const f = await fixture();
    try {
      const contract = new Contract();
      const imported = await f.engine.command(ctx, {
        commandId: "html-import",
        type: "vc.ImportContent",
        payload: { format: "html", content: page },
      });
      if (!imported.ok) throw Error(imported.error.message);
      const { artifactId } = contract.read<{ artifactId: string }>(
        "operations/vc.ImportContent",
        imported.result,
        "#/properties/result",
      );
      const artifact = contract.read<{ mediaKind: string; title: string }>(
        "operations/vc.Artifact",
        await f.engine.query(ctx, { name: "vc.Artifact", args: { artifactId } }),
        "#/properties/result",
      );
      expect(artifact).toMatchObject({ mediaKind: "html", title: "Field report" });
      const capabilities = contract.read<{ mediaKinds: string[] }>(
        "operations/sys.Capabilities",
        await f.engine.query(ctx, { name: "sys.Capabilities", args: {} }),
        "#/properties/result",
      );
      expect(capabilities.mediaKinds).toEqual(["doc", "html"]);
      const started = await f.engine.command(ctx, {
        commandId: "html-export",
        type: "vc.Export",
        payload: { target: { artifactId, version: 1 }, format: "html" },
      });
      if (!started.ok) throw Error(started.error.message);
      const { exportId } = contract.read<{ exportId: string }>(
        "operations/vc.Export",
        started.result,
        "#/properties/result",
      );
      let blobHash: string | undefined;
      for (let i = 0; i < 100 && !blobHash; i++) {
        const records = contract.read<Array<{ exportId: string; status: string; blobHash?: string }>>(
          "operations/vc.Exports",
          await f.engine.query(ctx, { name: "vc.Exports", args: {} }),
          "#/properties/result",
        );
        blobHash = records.find((r) => r.exportId === exportId && r.status === "completed")?.blobHash;
        if (!blobHash) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const out = new TextDecoder().decode(await f.engine.getBlob(ctx, blobHash!));
      expect(normal(out)).toBe(normal(page.replace("loose words", "<span>\nloose words\n</span>")));
      // The engine's own export page (its stylesheet, its title heading) is not wrapped around it.
      expect(out).not.toContain("max-width:72ch");
    } finally {
      await f.close();
    }
  });
});
