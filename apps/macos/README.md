# VibeCab macOS app

Run the Electron end-to-end suite from the repository root with:

```sh
pnpm test:e2e
```

The command builds the app, applies the Electron security fuses, then runs the Playwright lifecycle tests. Electron downloads its platform binary during dependency installation; rerun `pnpm install` if the binary is missing.
