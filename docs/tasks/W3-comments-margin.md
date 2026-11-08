# Task W3 — Comments and margin threads

Prerequisite: W2. Read: `W0-web-app-plan.md` (margin notes, icon bar); `AGENTS.md` §9–§10; design §5.4 (anchors), §6.1 (comments); task A2 §4–§5 (same behaviour, new layout).

## Goal

The person selects words (or points at a block) and comments; the thread appears in the margin beside that text; the agent's reply arrives there live. One place per thread. Agreement and Updates are W4; their buttons do not appear yet.

## 1. Commenting

- **On words:** selecting text inside one text element shows a small floating **Comment** button by the selection (also ⌘⌥M). The anchor is `{ artifactId, elementId, seenVersion, locator: { quote, prefix, suffix } }`, with up to 32 characters of prefix and suffix from the element's plain text (`apps/ui/src/document/anchors.ts`). A selection across elements anchors to the first element and quotes only its part.
- **On a block:** a quiet `+` in the left gutter on hover or focus for every top-level block and list item; comments without a locator.
- **General:** the icon bar's comment button, for the session as a whole (no anchor).
- **Composer:** a card in the margin at the anchor (a bottom sheet below 1280px): body, optional **Suggest a replacement** (prefilled with the quote), **Comment** (⌘↩), **Cancel** (Esc). The text stays if sending fails. Ended sessions show no composer or gutter.
- Replies inside a thread; edit and delete your own comments (delete asks first).

## 2. Margin threads

- ≥1280px: the Document shifts left of centre and a 300px margin sits to its right. Each thread card sits at the height of its anchor and is pushed down when it would overlap the one above. Threads with no anchor or a removed anchor follow after the last anchored card.
- Below 1280px: threads live in a sheet from the right, opened from the icon bar (with a count) or by clicking highlighted text.
- Card: the quote as a muted pull-quote; the comments (You / Agent / System, "via MCP" or "via CLI" when the channel says so; relative time; text as plain text); the feedback state as words from `terms.ts`; for the latest human comment, its delivery ("Waiting for the agent", "The agent is replying…"). Agent proposals show read-only as "Agent proposes: …".
- Highlights through the CSS Custom Highlight API, never by changing the text: `current` → sedge highlight on the quote; `revised` → glacier tint on the element and "Text changed since this comment"; `removed` → "This part was removed" in the card. The focused thread's highlight is stronger.
- Clicking a highlight focuses its card; clicking a card scrolls to its text; ↑/↓ move between cards, ↩ opens the reply composer.
- Filters in the icon bar: Open / All, Mine / Agent, Has suggestion.

## 3. Icon bar

One floating bar at the bottom centre of the Document (Handscroll): Comment, Threads (count; toggles the margin on wide screens, opens the sheet on narrow ones), Filter. Later tasks add Ask agent, Update, History, Snapshot, Export.

## 4. Shared anchor rule

The rule that finds a quote in an element (prefix + quote + suffix if unique, else the quote if unique) moves to `contract/src` and is used by both the engine and the web app.

## 5. Tests (write first)

- Selection to anchor: offsets from a DOM selection over inline markup map to the exact `quote`, `prefix`, `suffix` (≤32) of the plain text; a selection across two elements is clipped to the first.
- Quote finding: unique context, unique quote, ambiguous quote → none; same answers as the engine.
- Margin layout: cards keep anchor order and never overlap; unanchored threads come last.
- Integration (real web host, scripted model): comment on a range → thread appears in the margin with its highlight; the scripted agent reply arrives live; block and general comments; reply; edit; delete; filters.
- Browser check: seeded session, Summer and Polar night, 1440 / 1024 / 768 / 375px; console clean.

## 6. Out of scope

Agree, Decline, options, Ask agent, reply modes, conflicts, Updates, diffs (W4).
