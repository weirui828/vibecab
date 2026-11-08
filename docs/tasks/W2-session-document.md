# Task W2 — Session view: Document, Drafts in a session, catching up

Prerequisite: W1. Read: `W0-web-app-plan.md` (visual rules, Handscroll bar); `AGENTS.md` §9–§10; design §5 (content), §9.3 (continuity); task A2 §2, §3, §6 (same behaviour, new layout).

## Goal

Opening a session shows its Document as the page: calm, centred, beautifully set, at every width, live when a new version lands. Comments and threads are W3; nothing in W2 offers an action that does not work yet.

## 1. Layout

- Route `/s/:sessionId`, and `/s/:sessionId/d/:artifactId` for a specific Draft (default: the primary Draft, else the first).
- **Header** (sticky, hairline below, translucent): session title; Draft tabs as a segmented control when the session has more than one Draft; a mono facts line (`version 2 · 7 blocks · updated 3m ago`, plus `Paused` / `Ended` when not active); a `⋯` menu on the right with: Add a Draft (new blank or import), Attach an existing Draft, Rename, Pause / Resume, End, Move to Trash.
- **Catching up:** a one-line strip under the header when `vc.ResumeView` has anything: `Since you were here · version 2 · 1 reply · 2 comments` and **Show** / **Got it**. **Show** opens a small panel listing each item once (versions with change counts, replies, comments, items waiting for agreement, conflicts, Updates, last Snapshot) and the session digest marked "Written by the agent". **Got it** dismisses. The resume view is read once when the session opens; `vc.MarkSeen` is sent after 3 s with the tab visible and focused.
- **Document:** centred, max 68ch, generous top margin; nothing sits on it. Below 720px it fills the width with an 20px gutter.
- Empty session: one sentence and **Add a Draft**. Empty Document: "Nothing written yet." in the Document's place.

## 2. Document renderer

- Built from `vc.Elements` for the head version (tree from `parentId`, sibling order from `order`). Every `doc` type: heading 1–6, paragraph, list (ordered / unordered, nested), list item, quote, code block (mono, language label, no highlighting dependency), table (header row), image (`/v1/blobs/<hash>`, alt, caption), divider, callout (info / note / warning, quiet tinted block with an icon, never colour alone).
- Inline subset through the shared parser in `contract/src/inline-markdown.ts`; links open in a new tab only for `http:`, `https:` and `mailto:`; anything else renders as text. Never `dangerouslySetInnerHTML`.
- Every rendered element carries `data-element-id`.
- Type: Fraunces for h1–h3, Instrument Sans for the rest; body 17px / 1.7 on wide screens, 16.5px on phones.
- Large Documents render the first 300 top-level blocks and add more as the reader nears the end.
- Live: on `vc.VersionCommitted` for this Draft, refetch and keep the element at the top of the viewport in place; toast "Updated to version N".

## 3. Tests (write first)

- Renderer: each element type from a fixture tree; `data-element-id` on every element; inline links with unsafe schemes render as text; agent text containing HTML renders as text.
- Integration (real web host and engine): a session opens on its primary Draft; Draft tabs switch Drafts; an Update committed outside the UI refreshes the Document and shows the toast; the resume strip lists items and **Got it** hides it; `vc.MarkSeen` is sent.
- Browser check: seeded session in Summer and Polar night at 1440, 1024, 768 and 375px; console clean.

## 4. Out of scope

Commenting, threads, highlights, the floating action bar (W3); agreement and Updates (W4); history and read-only versions (W5).
