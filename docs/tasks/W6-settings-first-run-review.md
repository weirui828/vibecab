# Task W6 — Settings, first run, accessibility and visual review

Prerequisite: W5. Read: `W0-web-app-plan.md`; task A5 (same behaviour, new layout); `W7-electron-proposal.md` (written at the end of this task).

Status: built in two parts (W6a: Settings, first run, sign-in links, port; W6b: "Why is this here?", end-to-end suite with axe, Electron proposal). This file was written after the work, to record what W6 covers.

## Goal

Parity with the Electron app: everything a person sets up once, a first hour that needs no manual, and proof that every screen is accessible and looks right in both themes and at both widths.

## 1. Settings (`/settings`)

One quiet column of sections, each saving on its own:

- **Model** — provider, model, API key. The key goes through the web host to the keychain (`sys.SetProviderKey`) and is never shown again ("Key saved"). The model is saved first (pricing defaults to 0/0), then the key.
- **Spending** — daily limit.
- **The agent** — reply delay and other agent defaults.
- **What the agent may do** — grants.
- **Connected tools** — tool access.
- **Your AI assistant** — MCP access: the client config is shown once, through the relay `adapters/mcp-server/bin/vibecab-mcp.mjs`; disabled until the workspace is loaded.
- **Your data** — workspace location, backups.
- **Open on another browser** — a fresh one-time sign-in link (`/app/launch-link`).
- **Appearance** — light, dark or system.
- **About** — version and workspace.

## 2. First run

Welcome → choose a model → a daily limit (skippable) → your first Draft (or Later) → an empty Home. Once shown, first run stays latched until it finishes; saving a model halfway does not end it.

## 3. Signing in and the port

- The web host listens on `127.0.0.1:5163` by default.
- A browser without a session sees "Sign in this browser" and the command that prints a fresh link: `node apps/web/bin/vibecab-web.mjs link`.

## 4. "Why is this here?"

From a block's menu: the block's decision record (`vc.DecisionRecord`), oldest first — every agreed change about it (what was asked, how it was agreed) and every Update that changed it.

## 5. Accessibility and visual review

- Playwright (Chromium) end-to-end journey against the built web host, a fresh workspace and the scripted model (`apps/web/dev/fake-provider.json`): first run → Settings → a Draft from Markdown → a comment → the agent's options → agree → Update → changes → Snapshot → history → the other screens. Run with `pnpm test:e2e:web`.
- axe-core on every screen, no serious or critical violations. axe is loaded through `page.evaluate`, so the page's strict CSP stays on. Motion is reduced so contrast is never measured mid-animation.
- Screenshots of each screen in light and dark, at 1440×900 and 375×812, in `apps/web/test-results/screens` (gitignored), reviewed by eye.

## 6. Retiring `apps/ui`

Not done here. The options and a recommendation are in `W7-electron-proposal.md`, for Wei to decide.

## 7. Tests

- Integration (real web host): `apps/web/test/settings.integration.test.tsx`, covering saving a model and key (the key never appears in the page), spending, agent defaults, grants, the assistant config, and first run.
- Unit tests for `whyEntries`.
- End-to-end: `apps/web/e2e/journey.spec.ts` (6 tests).
