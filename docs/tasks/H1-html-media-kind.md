# Task H1 — HTML Drafts

Approved by Wei on 2026-11-10: the limit on new media kinds is lifted for `html` only (`page`, `canvas`, `music` stay out of scope).

Read: `engine/src/content/*`, `contract/schemas/element.json`, `contract/src/index.ts`, `engine/src/lifecycle/render.ts`, `apps/web/src/session/DraftDocument.tsx`, `apps/web/src/session/CommentSurface.tsx`.

## Goal

Wei often asks an assistant for a document as one HTML file, then reads and reviews it. Such a file becomes a Draft as it is: it looks the same, it can be commented on block by block, an Update rewrites only the agreed blocks, and it exports as the same file with those blocks changed. The HTML is not converted into the `doc` block types.

## 1. The `html` media kind

An artifact has `mediaKind: "doc" | "html"`. An `html` artifact holds only these element types; a `doc` artifact never holds them.

| Element type | Props | Content | Children |
|---|---|---|---|
| `html_head` | `htmlAttrs`, `bodyAttrs` (attribute maps of `<html>` and `<body>`) | `html`: what is inside `<head>`, whole | — |
| `html_node` | `tag`, `attrs` | — | `html_node`, `html_block` |
| `html_block` | — | `html`: exactly one element, with everything inside it | — |

- `html_head` is top-level and there is at most one. Styles and scripts in the head are kept whole inside it.
- A source element becomes an `html_node` when it only groups blocks: its tag is a grouping tag (`div`, `main`, `section`, `article`, `header`, `footer`, `aside`, `nav`), it has no text of its own, and every child is a block-level element. Everything else is an `html_block`, kept as its own markup. So wrappers and their classes survive, and a paragraph, a table, a list, a `<script>` or a `<style>` in the body is one block.
- Loose text directly in `<body>` or in a grouping element makes that element an `html_block` (for `<body>`: the loose text is wrapped in a `<span>` block). Comments in the source between blocks are dropped.
- `html_block.html` is validated at every boundary: it must parse to exactly one element. It is stored as given; there is no second canonical form.
- Element ids, order, versions, write sets and "untouched means untouched" work as for `doc`.

## 2. Import and export

- `vc.ImportContent` gains `format: "html"`. With no `artifactId` it creates an `html` artifact at version 1. Importing HTML into an existing artifact is `invalid` in this task.
- The title is the payload's `title`, else the document's `<title>`, else "Untitled".
- Export with `format: "html"` of a target that is one `html` artifact returns the document rebuilt from its elements: doctype, `<html>` and `<body>` with their attributes, the head, the tree. For the same content this equals the imported file after one parse-and-serialize pass. In an export of several documents, an `html` artifact contributes its body. Markdown export gives each block's plain text.
- Nothing is fetched. A file that names outside stylesheets, fonts or images keeps those names; the page that shows it does not load them (see 4). Inlining outside resources at import is a later task.

## 3. Feedback and Updates

- A comment on an `html` Draft points at an element id, with no place inside the block (no `locator`). Text-range comments on HTML are a later task.
- The Update planner and writer receive the elements as they are and return element drafts of the same types; the writer's `html` is validated like any other. The prompts say what an `html_block` is and that its tag and attributes stay unless the request is about them.
- `vc.Diff` lists changed blocks; it gives no word diff for `html` blocks.
- `vc.Outline` previews an `html` block by its plain text.

## 4. The web app

- A Draft whose artifact is `html` is shown in a sandboxed frame: `sandbox="allow-scripts"` only (its own origin; no forms, pop-ups, top navigation or same-origin access), filled from `srcdoc`, with a content security policy placed first in its head that allows inline styles and scripts, `data:` and `blob:` images and fonts, and no network. Scripts in the file run inside it.
- The frame is as tall as its content; the page scrolls, not the frame.
- The frame tells the page where its blocks are and which one the pointer is over, through `postMessage` with a token made for that frame. The page draws its comment button, thread cards and plumb-line beads from that. Threads show beside the text on a wide window and under the Draft on a narrow one.
- New Draft has "Import HTML" next to "Import Markdown".
- The same view shows an older version and the changes of an Update (changed blocks outlined).
- User-facing words: an HTML Draft is a Draft. No engine names in text.

## 5. Out of scope

Editing HTML by hand in the app; text-range comments; fetching or inlining outside resources; a switch for scripts; pages whose content is made by scripts (they import, but only the source's own blocks can be commented on); HTML through the CLI and MCP beyond what `vc.ImportContent` already gives them.

## 6. Tests (write first)

- Contract: an `html_block` must be exactly one element; `doc` and `html` types never mix in one tree; `html_head` is top-level and single; `html_node` takes only `html_node` and `html_block`.
- Property: for generated HTML documents, import then export equals the parse-and-serialize of the source; importing twice gives the same tree shape.
- Invariant 6 on an `html` artifact: an update to one block leaves every other element's revision hash as it was, the head included.
- Import: wrappers become nodes, blocks keep their markup, head styles and scripts are kept whole, loose body text becomes a block, the `<title>` names the Draft.
- An Update on an `html` Draft with the scripted provider rewrites only the agreed block; a writer that returns two elements for one block is rejected.
- Export: one `html` artifact comes back as a whole document.
- Web: the frame's document carries the policy first, the sandbox has no `allow-same-origin`, every block carries its element id, a message with the wrong token is ignored, a block's comment button opens a thread anchored to that element.

## Done when

`pnpm gen && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check` passes apart from the failures recorded in `docs/questions.md`, and an HTML file imported in the app can be read, commented on, updated and exported.
