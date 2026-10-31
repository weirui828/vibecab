import { expect, it } from "vitest";
import { Contract } from "../../contract/src/index.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import { JobRunner } from "../src/kernel/jobs.js";
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it("fences expired job attempts so an old handler cannot complete a new lease", async () => {
  const store = new SqliteStore(":memory:", new Contract());
  let now = "2026-10-28T00:00:00.000Z";
  const gates = [deferred(), deferred()],
    starts = [deferred(), deferred()];
  let count = 0;
  const mutate = <T>(action: () => T) => Promise.resolve(store.transaction(action));
  const runner = new JobRunner(store, { now: () => now }, mutate, {
    leaseMs: 1000,
    handlers: {
      "test.noop": async () => {
        const i = count++;
        starts[i]!.resolve();
        await gates[i]!.promise;
      },
    },
  });
  store.transaction(() => store.enqueue("test.noop", "one", {}, now));
  const first = runner.tick();
  await starts[0]!.promise;
  now = "2026-10-28T00:00:02.000Z";
  const second = runner.tick();
  await starts[1]!.promise;
  try {
    gates[0]!.resolve();
    await first;
    expect(store.jobs()[0]).toMatchObject({ state: "leased", attempts: 2 });
    gates[1]!.resolve();
    await second;
    expect(store.jobs()[0]).toMatchObject({ state: "completed", attempts: 2 });
  } finally {
    gates.forEach((g) => g.resolve());
    await Promise.allSettled([first, second]);
    store.close();
  }
});
it("does not write after drain interrupts an unfinished handler and storage closes", async () => {
  const store = new SqliteStore(":memory:", new Contract()),
    gate = deferred(),
    started = deferred(),
    now = "2026-10-28T00:00:00.000Z";
  const runner = new JobRunner(store, { now: () => now }, async (action) => store.transaction(action), {
    leaseMs: 1000,
    handlers: {
      "test.noop": async () => {
        started.resolve();
        await gate.promise;
      },
    },
  });
  store.transaction(() => store.enqueue("test.noop", "one", {}, now));
  const tick = runner.tick();
  await started.promise;
  await runner.drain(0);
  expect(store.jobs()[0]).toMatchObject({ state: "interrupted" });
  store.close();
  gate.resolve();
  await expect(tick).resolves.toBeUndefined();
});
it("lets handlers finish during the drain grace period", async () => {
  const store = new SqliteStore(":memory:", new Contract()),
    gate = deferred(),
    started = deferred(),
    now = "2026-10-28T00:00:00.000Z";
  const runner = new JobRunner(store, { now: () => now }, async (action) => store.transaction(action), {
    leaseMs: 1000,
    handlers: {
      "test.noop": async () => {
        started.resolve();
        await gate.promise;
      },
    },
  });
  store.transaction(() => store.enqueue("test.noop", "one", {}, now));
  const tick = runner.tick();
  await started.promise;
  const drain = runner.drain(1000);
  gate.resolve();
  try {
    await drain;
    await tick;
    expect(store.jobs()[0]).toMatchObject({ state: "completed" });
  } finally {
    store.close();
  }
});

it("finishes the current trash sweep item before completing drain", async () => {
  const store = new SqliteStore(":memory:", new Contract()),
    gate = deferred(),
    started = deferred(),
    now = "2026-10-28T00:00:00.000Z";
  const runner = new JobRunner(store, { now: () => now }, async (action) => store.transaction(action), {
    leaseMs: 1000,
    handlers: {
      "trash.sweep": async () => {
        started.resolve();
        await gate.promise;
      },
    },
  });
  store.transaction(() => store.enqueue("trash.sweep", "sweep", {}, now));
  const tick = runner.tick();
  await started.promise;
  let finished = false;
  const drain = runner.drain(0).then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  gate.resolve();
  try {
    await Promise.all([drain, tick]);
    expect(store.jobs()[0]).toMatchObject({ state: "completed" });
  } finally {
    store.close();
  }
});
