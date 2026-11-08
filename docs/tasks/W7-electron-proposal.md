# W7 — What to do with the Electron app (proposal, for Wei to decide)

Status: proposed 2026-11-08, after W6. Nothing here is built.

## Where things stand

- `apps/web` now does everything the Electron renderer (`apps/ui`) does, with the new design, and is covered by unit, integration and Playwright end-to-end tests (including axe on every screen).
- `apps/ui` + `apps/macos` still work, but every product change now has to be made twice, and `apps/ui` keeps its own 2,300-line stylesheet and 24-test legacy (several of its integration tests already fail on `main`).
- What only Electron gives today: a Dock app and menu-bar item, launch at login, a native window without a browser's chrome, and native save/open dialogs.

## Options

**A. Keep the Electron shell, load the web app (recommended).**
Electron main starts the web host (`apps/web/server`, already engine-lifecycle aware) instead of serving `apps/ui`, signs its own window in with a launch link it generates in-process, and loads `http://127.0.0.1:5163`. The menu bar, login item and packaging from A5 stay. `apps/ui` is deleted once A is in.
- Pro: one UI; the native feel stays; little new code (the shell already starts and watches the engine).
- Con: Electron's size and update cost remain.

**B. Retire Electron.**
Run the web host at login (a LaunchAgent plist installed by `vibecab-web install`), and open VibeCab in the person's browser or as an installed browser app (PWA manifest + service worker for the window and icon).
- Pro: no Electron to package or update; smallest footprint.
- Con: no menu-bar item; the window lives inside a browser; "launch at login" becomes a small setup step.

**C. Keep both renderers.** Not recommended: every change twice.

## Recommendation

A now (one renderer, same Mac experience), and revisit B when a PWA is good enough for daily use. Steps for A: (1) `apps/macos` starts the web host in-process and loads its URL; (2) its preload shrinks to what a page cannot do (native dialogs, reveal in Finder), exposed to the web app through a small optional bridge the web app already tolerates being absent; (3) move A1–A5 E2E checks to the web journey; (4) delete `apps/ui`.
