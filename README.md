# VibeCab local core

Headless TypeScript engine for Task 01: JSON Schema contract, serial command kernel,
SQLite history, structured `doc` content, and in-process / loopback HTTP adapters.
Feedback, Updates, model providers, TMR, and UI are outside this milestone.

Use Node 22 and pnpm 10. The workspace pins a Node 22 development binary, so pnpm
scripts also work when the host's default Node differs.

```sh
pnpm install
pnpm gen
pnpm typecheck
pnpm lint
pnpm test
pnpm test:prop    # 1,000 runs per property; failures include a reproducible seed
pnpm build
pnpm test:build   # validate the emitted JavaScript on Node 22
```

`contract/schemas/` is the source of truth. `pnpm gen` regenerates TypeScript;
never edit `contract/generated/` directly. The build emits a runnable JavaScript
workspace under `dist/`, including the schemas needed for runtime validation.
Workspace package exports point at TypeScript sources for development.

```js
import { createEngine } from './dist/engine/src/engine.js';
import { inProcess } from './dist/adapters/in-process/src/index.js';

const engine = createEngine();
await engine.start('/path/to/workspace');
try {
  const client = inProcess(engine);
  const result = await client.command({
    commandId: 'my-import-1',
    type: 'vc.ImportContent',
    payload: { title: 'Draft', format: 'markdown', content: '# Draft\n\nHello.' },
  });
  console.log(result);
} finally {
  await engine.stop();
}
```

Imports append to existing artifacts. Restore creates a new version using the
historical manifest, preserving element IDs and anchors. Commands are idempotent,
including authorized commands that fail validation or domain checks.

The HTTP adapter starts only when explicitly hosted with `startHttp(engine,
{ workspaceDir })`. It binds `127.0.0.1`, checks Host and Origin, and requires bearer
authentication on every route. Scoped tokens are stored in `access-tokens.json`
with mode `0600`; callers must handle the returned tokens as secrets. HTTP request
bodies are capped at 16 MiB. Events support cursor replay, `Last-Event-ID`, and an
optional JSON `filter` query parameter matching the subscription schema.

Each workspace owns `workspace.sqlite` in WAL mode, a process lock, and
content-addressed blobs. The outbox is a tested runner skeleton; this milestone
registers no production job handlers. Clock and ID generation are injectable;
tests use deterministic values and never call model providers.
