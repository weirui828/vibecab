# Task W1 — Web host, browser bridge, app shell, Home

Prerequisite: A4 (the engine and contract as they are on `main`). Read: `W0-web-app-plan.md`; `AGENTS.md` §9; `docs/design/app-look.md`; `docs/design/app-events.md`; design §19 (contract), §20.1 (HTTP mapping and local-server safety); task A1 §3 (ContractBridge), A2 §1 (Home).

## Goal

`pnpm web` opens VibeCab in the browser against a real engine. The shell (sidebar, routing, connection states, theme) and the Home screen are finished and polished. Session view and everything after it are W2+; in W1, opening a session shows a placeholder.

## 1. Package

- `apps/web` — `@vibecab/web`: React 19, Vite, Tailwind v4, `@wei/design-system` (`file:../../vendor/wei-design-system-0.1.0.tgz`). `index.html` with `data-theme="tundra"`, strict CSP (`default-src 'self'`; no remote origins), fonts from the design-system package.
- `apps/web/server` — the web host (TypeScript, Node 26, no new runtime dependencies beyond what the repository already has).
- `scripts/vendor-design-system.mjs` updates the `@wei/design-system` reference in both `apps/ui` and `apps/web`.
- Shared code from `apps/ui/src` is imported, not copied (`copy/terms.ts`, `copy/errors.ts`, `connection.ts`, `coalesce.ts`, `ContractBridge` type).
- Root scripts: `pnpm web`, `pnpm web:dev`; `pnpm build` also builds `apps/web`.

## 2. Web host

- `vibecab-web [--workspace <dir>] [--port <n>] [--no-open]`. Default workspace: the same default the macOS app uses (`apps/macos/src/paths.ts`); move the default into a shared helper if needed rather than duplicating it.
- Engine: `@vibecab/host` `status(workspace)`; reuse if running, else `start(workspace, { nodePath: process.execPath })`. Read the app token from `<workspace>/.vibecab/app-token`. On `unauthenticated` from the engine: restart the host once and retry, as A1 §2 does.
- Development only (`VIBECAB_DEV=1`): `--fake-provider <script>`, `--temp-workspace`, `--seed` (runs a seed that imports Documents, starts a session, posts comments and an agent reply, and commits one Update; based on `apps/ui/preview/seed.mjs`). `--fake-provider` and `--seed` are refused without `VIBECAB_DEV=1`.
- HTTP, `127.0.0.1` only:
  - `GET /?launch=<secret>` — compares in constant time with the secret generated at start (32 random bytes, base64url, single use); sets `vc_web=<session id>; HttpOnly; SameSite=Strict; Path=/` and redirects to `/`. Prints the launch URL once on stdout and opens it unless `--no-open`.
  - Every other request: `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; if `Origin` is present it must be this origin. `/v1/*` and `/app/*` require the cookie, else `401` with a `ContractError` body; static files are served without it (they contain no data). Without the cookie, `/` shows a short page explaining how to open VibeCab (`pnpm web` prints the link).
  - `/v1/commands/*`, `/v1/queries/*`, `/v1/blobs/*`, `/v1/capabilities` forwarded to the engine with `Authorization: Bearer <app token>`; incoming `Authorization`, `Cookie`, `Origin` and `Referer` headers are not forwarded.
  - `/v1/events` SSE forwarded as a stream; `Last-Event-ID` / `after` passed through.
  - `/app/state` → `{ connection: "Starting" | "Connected" | "Engine stopped" | "Engine unreachable", version, workspacePath }`; `/app/start-engine` → start and return the new state.
  - Response headers on everything: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on `/v1` and `/app`, the CSP from §1 on HTML.
- `web:dev` runs the same host with Vite in middleware mode, so the browser still sees a single origin.

## 3. Browser bridge

- `apps/web/src/bridge/webBridge.ts` implements `ContractBridge` (A1 §3) with `fetch` and `EventSource` against the same origin. `commandId` is generated per user action and reused on retry. `subscribe` reconnects with the last seen `seq` after drops and never delivers an event twice or out of order. `blobUrl(hash)` → `/v1/blobs/<hash>`. `app.*` members that only make sense in Electron are absent from the web `AppBridge`; the web app has its own narrower `WebAppBridge` type.
- A live store: one subscription per tab; each event invalidates the queries listed for it in `app-events.md`; queries refetch only while a visible view uses them (coalesced, `coalesce.ts`).

## 4. Shell

- Hash routing: `/` Home, `/needs-you`, `/s/:sessionId` (placeholder in W1), `/drafts`, `/settings` (placeholder), `/trash` (placeholder).
- **Sidebar (248px):** VC wordmark (SVG from `apps/ui/src/assets/brand`), tagline, nav (Home, Needs you with count, Drafts), `SESSIONS` list with state mounds (moss active, sedge needs you, glacier agent working, muted paused / ended) and attention counts, footer: connection mound + label, theme switch `Auto · Summer · Polar night` (stored in `localStorage`; Auto follows `prefers-color-scheme`), `Settings · Trash`, mono version line.
- **Responsive:** ≥1024px fixed sidebar; 720–1023px sidebar collapses to an icon rail (tooltips on hover and focus); <720px a top bar with the mark, the page title and a menu button opening the sidebar as a sheet (focus trapped, `Esc` closes).
- **Connection states:** *Starting* (skeleton shell), *Connected*, *Engine stopped* with **Start engine**, *Engine unreachable* with **Try again** — a full-width `Alert` under the top of the page, never a blank screen.
- Errors map to short messages through `copy/errors.ts`; toasts for transient results ("Moved to Trash · Undo").

## 5. Home

Page header: `HOME` label, Fraunces title (time-of-day greeting is fine; one display title only), mono meta line (`3 sessions · 5 Drafts · 2 need you`), one moss button **New draft**, quiet **New session**.

Sections, in this order, each hidden when empty except as noted:

1. **Needs you** (`vc.AttentionInbox`): up to five items grouped by session — kind icon, one-line text, session name, relative time; **Open** goes to the session (W2 routes to the thread later). "Everything is answered." line when empty (shown only if there are sessions).
2. **Sessions** (`vc.Sessions`): a plain list, not a card grid. Each row: mound, title (Instrument Sans, medium), one muted facts line (`2 Drafts · 1 needs you · 3h ago`, mono), and a `⋯` menu that appears on hover and focus (Rename, Pause / Resume, End, Move to Trash). Rows separated by hairlines, no borders or backgrounds around rows. Ended sessions behind a "Show ended (n)" link.
3. **Drafts** (`vc.Artifacts`): the same row style: title, facts line (`Document · in Covibe explainer · updated 2d ago`), `⋯` menu (Open in a session, Rename, Move to Trash). A single search field above the list, shown only when there are more than eight Drafts.

Look (Handscroll bar, `W0` "Taste reference"): one column, max 760px, centred; large top margin; section labels in the 11px uppercase style; no cards, no badges unless they carry a count; the moss colour only on **New draft**. If the page looks busy, remove things before adding styling.

Empty workspace: hill row → `Nothing drafted yet.` (Fraunces) → one sentence → **New draft** → the three numbered steps (`app-look.md` "Empty Home").

Actions:

- **New draft** dialog: title, Blank Document or Import Markdown (browser file input, `.md` / `.markdown` / `.txt`, read as text in the browser) → `vc.CreateArtifact` or `vc.ImportContent` → `vc.StartSession` + `vc.AttachArtifact` (new session by default; or pick an existing session) → navigate to the session.
- **New session**: title → `vc.StartSession`.
- **Rename**: `vc.RenameArtifact` / `vc.RenameSession` in a small dialog.
- **Move to Trash**: `vc.Trash`; toast with **Undo** → `vc.Restore`.
- Dialogs: focus moves in, `Esc` closes, focus returns to the trigger; ⌘↩ submits.

Live: new events update Home without reload (sessions, Drafts, inbox).

## 6. Tests (write first)

- Web host (Vitest, real host with `VIBECAB_DEV=1 VIBECAB_KEYSTORE=memory` and the fake provider): launch secret is single use and sets the cookie; `/v1` without cookie → 401; foreign `Host` → 403; foreign `Origin` → 403; the token never appears in any response body or header, nor in the HTML; commands, queries and SSE events pass through; blob round-trip; `--fake-provider` refused without `VIBECAB_DEV=1`.
- Bridge: `webBridge` mapping (command result, query error → thrown `ContractError`), SSE reconnect resumes after the last `seq` with no duplicates (fake `EventSource`).
- Renderer (Testing Library, jsdom, through `webBridge` against a real web host): Home renders sessions, Drafts and inbox from the seeded workspace; New draft (blank and import) creates a session and navigates; trash + undo; empty state.
- Copy: no engine names (`artifact`, `OutputSet`, operation names) in JSX string literals of `apps/web/src` (extend the existing check); no hex colours in `apps/web/src`.
- Manual check, recorded in the task report with screenshots: Home and empty Home in Summer and Polar night at 1440, 1024, 768 and 390px; console free of errors and warnings.

## 7. Out of scope

Session view and everything inside it (W2–W4); settings, onboarding, keys (W6); Ideas and Projects (W5). Do not change the engine, contract or HTTP adapter; if the web host needs something they do not offer, record it in `docs/questions.md` and stop.
