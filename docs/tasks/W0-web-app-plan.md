# W0 — Web app: plan and visual direction

Status: proposed, 2026-11-07. Needs Wei's approval before W1 starts.

## Why

The Electron app (`apps/macos` + `apps/ui`) works but looks crowded, and debugging it is slow. A browser app can be driven and inspected directly (DOM, console, network), so it can be built and checked screen by screen. The engine, contract and adapters do not change.

## Where it lives

- **New package `apps/web`** (React 19, Vite, Tailwind v4, `@wei/design-system` from the vendored tarball, `data-theme="tundra"`). A fresh renderer, not a reskin of `apps/ui`: `apps/ui` has 2,300 lines of hand-written CSS and uses only `Button`, `Alert` and `Spinner` from the design system, so restyling it would mean rewriting it anyway.
- **Shared, not copied:** the non-visual parts of `apps/ui` are imported from where they are: `copy/terms.ts` (still the only source of user-facing domain words, `AGENTS.md` §9.2), `copy/errors.ts`, the inline-Markdown parser, anchor helpers, `connection.ts`, `coalesce.ts`, and the `ContractBridge` type. If a shared file needs a change for the web app, it changes in place and both apps keep passing their tests.
- **`apps/ui` stays** as the Electron renderer until the web app reaches parity (W6). W6 then proposes either pointing the Electron shell at `apps/web` or dropping Electron; that is Wei's decision at the time.

## How it reaches the engine

```
browser (apps/web renderer)
   │  same origin, HttpOnly session cookie
   ▼
web host  apps/web/server   127.0.0.1:<port>      ← plays the role of Electron main
   │  Bearer app token (read from <workspace>/.vibecab/app-token, never sent to the browser)
   ▼
engine HTTP adapter  127.0.0.1:<engine port>  (started or reused through @vibecab/host)
```

- The **web host** is a small Node server: it calls `@vibecab/host` `status` / `start` for the workspace (reuse a running engine, otherwise start one), serves the built renderer, and forwards `/v1/commands/*`, `/v1/queries/*`, `/v1/events` (SSE) and `/v1/blobs/*` to the engine with the app token added. It contains no domain logic.
- The renderer gets a `ContractBridge` implemented over `fetch` and `EventSource` (`webBridge`). It never sees the token, never opens a socket to the engine, never imports engine code (`AGENTS.md` §9.1).
- **Browser access is protected like the engine's own HTTP adapter (design §20.1):** bind `127.0.0.1` only; reject foreign `Host` and `Origin`; no CORS. On start the web host prints and opens a one-time launch URL (`http://127.0.0.1:<port>/?launch=<secret>`); the first visit swaps the secret for an `HttpOnly; SameSite=Strict` cookie and redirects to `/`. Without the cookie every `/v1` and `/app` request gets `401`. Without this step, any process or page on the machine could act as the person with admin scope.
- App-only functions that Electron main did (save provider key to the keychain, reveal workspace, restore backup, MCP relay path) become a few `/app/*` endpoints on the web host. File open and save use browser file inputs and downloads. Theme follows `prefers-color-scheme` with an override stored per browser.
- Commands: `pnpm web` (build, start web host, open the launch URL) and `pnpm web:dev` (same host with Vite in middleware mode for hot reload, one origin). `VIBECAB_DEV=1 pnpm web:dev --fake-provider <script> --seed` starts against a temp workspace with the scripted fake model and a realistic seeded session, for building and for screenshots.

## Visual direction

`docs/design/app-look.md` still sets the character (a calm writing room, not a dashboard; Fraunces / Instrument Sans / JetBrains Mono; moss primary, glacier for the agent, sedge for highlights; Summer / Polar night). What changes is the structure, which is where the current app fails.

What is wrong today (seen in the running app, 1440×900, both themes): the Document is squeezed between a Drafts column and a 360px rail; threads appear twice (inline under the text and in the rail); the header has four equal buttons and a second row of controls; the catch-up card sits on top of the Document; a decorative session diagram competes with content; nothing adapts below 960px.

### Start from first principles

Nothing in the layout of `apps/ui` is kept by default: not the three columns, not the sidebar contents, not the header, not the order of the sections. Every screen starts from two questions: what is the person here to do, and what is the least on screen that lets them do it well? Function is kept (every operation the Electron app offers must stay reachable); placement, grouping and chrome are redesigned from scratch. Bold changes are welcome when they make the screen calmer or the main task faster.

### Taste reference: Handscroll

Wei's Handscroll app (`weirui828.github.io/handscroll`, cover in `~/dev/media/handscroll/cover.png`) is the bar: plain and useful, with nothing piled up. What it does, and what VibeCab copies:

- **The work fills the screen.** The photo sits in the middle on an empty ground; the controls are around it, never on top of it.
- **One control row per screen.** A single segmented control (Split · Fit · Crop · Drift) chooses the mode. No second toolbar, no row of equal buttons.
- **Actions live in one quiet icon bar.** Six outline icons in one rounded bar at the bottom, no labels on the bar, tooltips and accessible names instead.
- **One line of facts.** `1080 × 1920 px · 30 fps` in small muted text under the work, not a stats panel.
- **Settings read like a page.** A heading, one sentence saying what it does, the control. No cards inside cards, no borders around every group, just space and thin dividers.
- **Restraint with colour.** Neutral paper ground; the accent appears only on the selected item, the slider fill, a switch. Everything else is ink and grey.
- **Generous space, few sizes.** Big margins, two or three type sizes per screen, aligned edges.

Applied to VibeCab: the Document is the photo; the session's mode switch (Read · Comment · Changes) is the segmented control; Ask agent, Update, History, Snapshot, Export and the `⋯` menu are the icon bar; `v3 · 26 blocks · 2 waiting on you` is the facts line; Settings is a single scrolling page of headed sections.

A screen is not finished until it passes this check: could anything be removed without losing a function? If yes, remove it.

Rules for the web app:

1. **The Document is the page.** Centred, 68ch, generous top margin. Nothing sits on top of it.
2. **Margin notes, not a rail.** Threads sit in the right margin next to the text they point at (each card aligned to its anchor, pushed down when they would overlap). One place per thread. Selecting a highlight focuses its note; general comments collect at the end of the margin.
3. **One header line, one icon bar.** The header holds only the session title, Draft tabs (when a session has several Drafts) and the mono facts line. Session actions sit in one floating icon bar (bottom centre of the Document on wide screens, bottom of the screen on phones), Handscroll-style; the moss colour is reserved for the one action the person most likely wants next (for example **Update** when there are agreed changes). Reply mode lives in the bar's agent menu.
4. **Catching up is a quiet strip** under the header ("Since you were here: v3, 2 replies, 1 waiting for you · Show"), opening a popover. Not a card over the text.
5. **Sidebar is navigation only:** wordmark, Home, Needs you (count), Sessions (with mounds), Drafts, Ideas, Projects; footer with connection, theme switch, Settings, Trash. Collapsible to icons.
6. **Design-system components first** (`Button`, `IconButton`, `Badge`, `Tabs`, `Card`, `Field`, `Input`, `Textarea`, `Select`, `Switch`, `Alert`, `Spinner`, `Skeleton`, `Progress`, `Icon`, `Table`). New components use only semantic tokens; no raw colours; a lint check or test fails on hex values in `apps/web/src`.
7. **Responsive:** ≥1280px full layout; 1024–1279px margin notes narrow and the sidebar collapses to icons; 720–1023px notes become a slide-over sheet opened from highlights or a count button; <720px sidebar becomes a top bar with a menu sheet and the Document goes full width. No horizontal scroll at any width.
8. **Motion** only from design-system tokens (`--duration-*`, `--ease-*`); nothing depends on it.

## Series

| # | Builds | Done when |
|---|---|---|
| W1 | `apps/web` package, web host (engine lifecycle, launch secret, proxy, SSE), `webBridge`, theme, app shell (sidebar, routing, connection states), **Home** (Needs you, Sessions, Drafts; new Draft / new Session; rename; trash with undo) | Home runs in a browser against a real engine, polished in light and dark at 1440, 1024, 768 and 390px |
| W2 | Session view: header, Draft tabs, Document renderer (all `doc` element types), live refresh on new versions, catch-up strip, session controls (pause / resume / end, attach Draft) | A seeded session reads beautifully at every width |
| W3 | Commenting (text range, whole block, general), composer, margin threads with anchor alignment, highlights (current / revised / removed), filters, edit / delete, live agent replies | Comment → agent reply appears live, in place |
| W4 | Agree / Decline / options, reply mode and Ask agent, conflicts, Update bar and stepper, plan review, result panel, diff view, budget and model-missing notices | Full loop in the browser with the fake model: comment → reply → agree → Update → diff |
| W5 | History and read-only versions, compare, restore, decision record; Snapshots and labels; export as download; Trash and purge; Ideas and Projects | Everything around the loop works in the browser |
| W6 | Settings (model, keys via web host to keychain, spending, agent defaults, grants, tools, MCP access, data and backup, appearance, about), first run, axe checks, Playwright suite, screenshot review; proposal for `apps/ui` and Electron | Parity with the Electron app; decision taken on retiring `apps/ui` |

Every W task: tests first (`AGENTS.md` §7), `pnpm gen && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check` passing (about 24 tests already fail on `main`; no new failures), every screen checked in the browser (screenshots, console free of errors, light and dark, 1440 / 1024 / 768 / 390px), decisions in `docs/decisions.md`, questions in `docs/questions.md`.

## Decisions for Wei

1. New `apps/web` sharing non-visual code with `apps/ui` (recommended), or rework `apps/ui` in place so Electron and browser share one renderer from day one.
2. Launch-URL secret + cookie for browser access (recommended), or a token typed into the page once.
3. Margin notes beside the text (recommended) instead of a threads rail.
4. Session actions in one floating icon bar, Handscroll-style (recommended), instead of header buttons.
