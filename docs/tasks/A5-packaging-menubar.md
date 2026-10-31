# Task A5 — Packaging, app icon, menu bar, login item

Prerequisite: A4. Read: `docs/decisions.md` "macOS app".

## Goal

A double-clickable `VibeCab.app` (and `.dmg`) for Apple Silicon that runs without a developer setup, lives in the menu bar when its window is closed, and keeps the door open to the Mac App Store later.

## 1. Build

- electron-builder (or Electron Forge with the DMG maker; record the choice). Target `mac` `arm64` only, `dmg` + `dir`. `LSMinimumSystemVersion` 14.0. Bundle id `app.vibecab.mac` (record in decisions). App name "VibeCab".
- `pnpm app:package` builds engine `dist/`, the renderer, and the Electron app in one command, from a clean checkout.
- Bundled engine in `Contents/Resources/engine/`:
  - `bin/node`: the Node 26.13.0 arm64 binary (from the `node` package already in devDependencies), ad-hoc signed;
  - `dist/` for engine, contract, adapters, host;
  - production `node_modules` for the engine only, with `better-sqlite3` and `@napi-rs/keyring` built for Node 26 arm64 (not for Electron's ABI);
  - `bin/vibecab` (CLI) and `bin/vibecab-mcp` (relay) shell wrappers that run the bundled `node`.
- Electron main uses `@napi-rs/keyring` built for Electron's ABI (separate copy); never load the engine's native modules in Electron.
- Size budget: report both artifact sizes; keep the `.app` under 420 MB.
- Signing: no Developer ID now. Ad-hoc sign the whole bundle (`codesign --force --deep -s -`), required for arm64 executables to run. Document first launch in `apps/macos/README.md`: right-click → Open, or `xattr -dr com.apple.quarantine /Applications/VibeCab.app` for a copied build. No auto-update.

## 2. App icon

- Source: the VC cab mark. Ask Wei for the original artwork and use it as-is (don't redraw it); the largest copy in `vibecab-0` is 180×180, which is too small. Until it arrives, generate a placeholder `.icns` from the 180 px PNG and mark it in `docs/questions.md` as pending.
- Produce `apps/macos/build/icon.icns` (all sizes up to 1024@2x) from a 1024×1024 PNG with `iconutil`; follow the macOS icon grid (rounded-rect background in cottongrass `#f3f1ea`, mark in moss `#4c5d3f`; dark-mode variant not required).
- Menu-bar icon: a monochrome template image (`iconTemplate.png` / `@2x`, 16 / 32 px) of the mark, so macOS tints it for light and dark menu bars.

## 3. Menu bar (Tray)

- Present while the app runs. Menu:
  - status line: "Engine running" / "Engine stopped"; "Updating ‘Launch post’…" while an Update runs; "3 items need you" from the attention inbox;
  - **Open VibeCab** (⌘O); **New draft**; recent sessions (up to 5);
  - **Pause agent replies** (sets every active session to manual and remembers the previous triggers; **Resume agent replies** restores them);
  - **Settings…**; **Quit VibeCab** (same drain behaviour as ⌘Q, A1 §2).
- Closing the window keeps the tray and the engine; the Dock icon hides when no window is open (`app.dock.hide()`), and shows again when a window opens.
- macOS notifications (opt-in in Settings → Appearance → Notifications, off by default): agent replied (when the window is not focused), Update committed or failed, conflict detected. Clicking opens the thread.

## 4. Login item

Settings → **Start VibeCab at login** (off by default) using `app.setLoginItemSettings({ openAtLogin, openAsHidden: true })`: starts into the menu bar with the engine running.

## 5. Mac App Store readiness (do not implement; do not preclude)

Record in `docs/decisions.md` what an App Store build would change, and keep the code ready for it:

- Sandbox: workspace moves to the app container; only `apps/macos/src/paths.ts` changes. Keychain access group instead of the plain service name.
- The bundled `node` runs as a sandboxed helper with `com.apple.security.inherit`; listeners on `127.0.0.1` need `com.apple.security.network.server` (and `.client` for model calls).
- The CLI and the MCP relay cannot be installed into `/usr/local/bin`; the MCP setup screen already points at the bundled relay path, which works inside the bundle.
- Developer ID or App Store signing, hardened runtime, notarization; Apple Developer Program membership.

## 6. Tests

- Packaged smoke test (CI on an arm64 macOS runner if available, otherwise a documented manual checklist in the README): launch the packaged app on a clean user account → onboarding → create Document → comment (with the fake provider build flag disabled, agent features show "Add a model") → quit → no `node` process left → relaunch reuses nothing stale.
- The bundled `vibecab` and `vibecab-mcp` wrappers work from Terminal against the app's workspace while the app runs.
- Tray state follows events (Update running, attention count) in an E2E test with the fake provider (dev build).
- Login item toggle round-trips.

## 7. Out of scope

Developer ID signing, notarization, App Store build, auto-update, Intel builds, Windows/Linux.
