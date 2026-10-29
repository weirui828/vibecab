import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../dist/engine/src/engine.js";
import { inProcess } from "../dist/adapters/in-process/src/index.js";
const dir = await mkdtemp(join(tmpdir(), "vibecab-build-"));
let next = 0;
const engine = createEngine({
  clock: { now: () => "2026-10-28T00:00:00.000Z" },
  ids: { next: (prefix) => prefix + String(++next).padStart(26, "0") },
  seed: 42,
});
try {
  await engine.start(dir);
  const client = inProcess(engine);
  const created = await client.command({
    commandId: "build-smoke",
    type: "vc.ImportContent",
    payload: {
      title: "Smoke",
      format: "markdown",
      content: "# Built engine\n\nHello.",
    },
  });
  assert.equal(created.ok, true);
  const elements = await client.query({
    name: "vc.Elements",
    args: { artifactId: created.result.artifactId },
  });
  assert.deepEqual(
    elements.map((e) => e.type),
    ["heading", "paragraph"],
  );
  assert.equal(elements[1].text, "Hello.");
  console.log("Built engine smoke test passed.");
} finally {
  await engine.stop();
  await rm(dir, { recursive: true, force: true });
}
