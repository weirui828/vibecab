import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createEngine } from "../src/engine.js";
import { Contract } from "../../contract/src/index.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import { JobRunner } from "../src/kernel/jobs.js";
import { ctx, fixture, clock, ids } from "./helpers.js";
describe("kernel", () => {
  it("serializes concurrent submissions and persists idempotency across restart", async () => {
    const f = await fixture();
    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, n) =>
          f.engine.command(ctx, {
            commandId: "c" + n,
            type: "vc.CreateArtifact",
            payload: { title: String(n), mediaKind: "doc" },
          }),
        ),
      );
      expect(results.map((r) => (r.ok ? r.seq : 0))).toEqual(Array.from({ length: 30 }, (_, n) => 2 * (n + 1)));
      await f.engine.stop();
      await f.engine.start(f.dir);
      expect(
        await f.engine.command(ctx, {
          commandId: "c0",
          type: "vc.CreateArtifact",
          payload: { title: "0", mediaKind: "doc" },
        }),
      ).toEqual(results[0]);
    } finally {
      await f.close();
    }
  });
  it("holds an exclusive lock and releases it on stop", async () => {
    const f = await fixture(),
      second = createEngine({ clock, ids: ids(), seed: 1 });
    try {
      await expect(second.start(f.dir)).rejects.toMatchObject({
        contract: { code: "unavailable" },
      });
      await f.engine.stop();
      await second.start(f.dir);
      await second.stop();
    } finally {
      await second.stop();
      await f.close();
    }
  });
  it("refuses concurrent starts on one engine without removing its active lock", async () => {
    const f = await fixture();
    await f.engine.stop();
    try {
      const results = await Promise.allSettled([f.engine.start(f.dir), f.engine.start(f.dir)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const second = createEngine({ clock, ids: ids(), seed: 1 });
      await expect(second.start(f.dir)).rejects.toMatchObject({
        contract: { code: "unavailable" },
      });
      expect(
        (
          await f.engine.command(ctx, {
            commandId: "after-race",
            type: "vc.CreateArtifact",
            payload: { title: "Alive", mediaKind: "doc" },
          })
        ).ok,
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("rolls back partial storage, events and outbox together", () => {
    const store = new SqliteStore(":memory:", new Contract());
    try {
      expect(() =>
        store.transaction(() => {
          store.createArtifact({
            artifactId: "art_test",
            title: "Partial",
            mediaKind: "doc",
            headVersion: 1,
            createdAt: clock.now(),
          });
          store.appendEvent({
            ts: clock.now(),
            type: "vc.ArtifactCreated",
            entity: { kind: "artifact", id: "art_test" },
            payload: {
              artifactId: "art_test",
              title: "Partial",
              mediaKind: "doc",
            },
          });
          store.enqueue("test.noop", "job", {}, clock.now());
          throw Error("crash");
        }),
      ).toThrow();
      expect(() => store.artifact("art_test")).toThrow();
      expect(store.eventsAfter(0)).toEqual([]);
      expect(store.jobs()).toEqual([]);
    } finally {
      store.close();
    }
  });
  it("recovers expired idempotent leases and marks drain leftovers interrupted", async () => {
    const store = new SqliteStore(":memory:", new Contract());
    let now = "2026-10-28T00:00:00.000Z";
    const injected = { now: () => now };
    const mutate = <T>(fn: () => T) => Promise.resolve(store.transaction(fn));
    const runner = new JobRunner(store, injected, mutate, {
      leaseMs: 1000,
      handlers: { "test.noop": async () => {} },
    });
    try {
      store.transaction(() => store.enqueue("test.noop", "one", {}, now));
      store.transaction(() => store.lease("one", "2026-10-28T00:00:01.000Z"));
      now = "2026-10-28T00:00:02.000Z";
      await runner.recover();
      await runner.tick();
      expect(store.jobs()[0]).toMatchObject({
        state: "completed",
        attempts: 2,
      });
      store.transaction(() => {
        store.enqueue("test.noop", "two", {}, now);
        store.lease("two", "2026-10-28T00:00:03.000Z");
      });
      await runner.drain(0);
      expect(store.jobs().find((j) => j.id === "two")).toMatchObject({
        state: "interrupted",
      });
    } finally {
      store.close();
    }
  });
  it("closes subscriptions on stop, rejects new work after drain, and never leaks secrets", async () => {
    const f = await fixture();
    try {
      const sub = f.engine.subscribe(ctx, { afterSeq: 0 })[Symbol.asyncIterator](),
        pending = sub.next();
      await f.engine.drain(0);
      await f.engine.stop();
      expect((await pending).done).toBe(true);
      expect(
        await f.engine.command(ctx, {
          commandId: "late",
          type: "vc.CreateArtifact",
          payload: { title: "late", mediaKind: "doc" },
        }),
      ).toMatchObject({ ok: false, error: { code: "unavailable" } });
      await f.engine.start(f.dir);
      const bad = await f.engine.command(ctx, {
        commandId: "bad",
        type: "vc.CreateArtifact",
        payload: { secret: "SENSITIVE", mediaKind: "doc" },
      });
      expect(JSON.stringify(bad)).not.toContain("SENSITIVE");
      expect((await readFile(join(f.dir, "workspace.sqlite"))).includes(Buffer.from("SENSITIVE"))).toBe(false);
    } finally {
      await f.close();
    }
  });
});
