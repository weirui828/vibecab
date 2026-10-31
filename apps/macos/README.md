# VibeCab macOS app

Run the Electron end-to-end suite from the repository root with:

```sh
pnpm test:e2e
```

The command builds the app and runs the Playwright lifecycle tests against the ordinary development Electron binary. It never changes files in `node_modules`.

Security fuses are applied to the packaged `.app` during packaging, through `configurePackagedFuses` in `fuses.mjs` (wired by the A5 `afterPack` hook). To inspect or configure a packaged app manually, pass its `.app` path to `pnpm --filter @vibecab/macos fuses -- /path/to/VibeCab.app`.

To verify a packaged app's fuse wire, run `VIBECAB_PACKAGED_APP=/path/to/VibeCab.app pnpm --filter @vibecab/macos test:fuses`.

If an earlier development run changed the dependency binary's fuses, restore the pristine Electron download with `pnpm install --force` before running `app:dev` or `test:e2e`.

Manual macOS check for A1c: after a clean install, launch `pnpm app:dev`, configure a provider key, quit and relaunch the app, then reconnect to the running host. macOS should not show a provider-keychain access prompt; Node host is the only process that reads and writes provider-key entries.

## Packaged app smoke check

Build with `pnpm app:package`. On a clean macOS user account, open `release/mac-arm64/VibeCab.app` (or install it from the DMG), right-click and choose **Open** on first launch if Gatekeeper blocks the ad-hoc signed build. After onboarding, create a Document, add a comment, and quit. With no model configured, agent actions should offer **Add a model**. Confirm no bundled `node` process remains after quit, then relaunch and confirm a fresh connection.

For an automated packaged launch check, run `pnpm app:smoke` after packaging on macOS with a logged-in GUI session. It launches the packaged executable in a temporary home and workspace, waits up to 30 seconds for the main process to log `VIBECAB_READY` after connecting the host and showing the window, and then cleans up the host and temporary files.

While the app is running, open Terminal and run `VibeCab.app/Contents/Resources/engine/bin/vibecab status --workspace "$HOME/Library/Application Support/VibeCab/workspaces/default"`. Configure `VIBECAB_WORKSPACE` and `VIBECAB_MCP_TOKEN` for the relay, then run `VibeCab.app/Contents/Resources/engine/bin/vibecab-mcp`; both wrappers should use the bundled Node 26 runtime and the app's running host. The MCP token is supplied by the caller and is never stored in the app bundle.

Login item smoke check: turn on **Start VibeCab at login** in Settings, verify the login item reports enabled, then turn it off. When macOS launches the app as a login item, it starts the engine and tray without opening a window.
