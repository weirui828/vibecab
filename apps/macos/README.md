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
