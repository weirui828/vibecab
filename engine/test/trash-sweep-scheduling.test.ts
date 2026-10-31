import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { Contract } from "../../contract/src/index.js";
import type { Job } from "../../contract/src/index.js";
import { advanceClock, ctx, fixture } from "./helpers.js";

it("runs a quiet sweep and schedules the next one for the next day", async () => {
  const f = await fixture(),
    db = new Database(join(f.dir, "workspace.sqlite"), { readonly: true });
  const completedCount = () => {
    const row: unknown = db
      .prepare("SELECT count(*) AS count FROM sys_outbox WHERE kind='trash.sweep' AND state='completed'")
      .get();
    return typeof row === "object" && row !== null && typeof Reflect.get(row, "count") === "number"
      ? Reflect.get(row, "count")
      : 0;
  };
  try {
    expect(completedCount()).toBe(0);
    advanceClock(5 * 60_000);
    for (let attempt = 0; attempt < 100 && completedCount() === 0; attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(completedCount()).toBe(1);

    const pendingRow: unknown = db
      .prepare("SELECT json FROM sys_outbox WHERE kind='trash.sweep' AND state='pending' ORDER BY rowid DESC LIMIT 1")
      .get();
    expect(typeof pendingRow).toBe("object");
    const raw = pendingRow !== null && typeof pendingRow === "object" ? Reflect.get(pendingRow, "json") : undefined;
    expect(typeof raw).toBe("string");
    const pending = new Contract().read<Job>("job", JSON.parse(String(raw)));
    expect(pending.payload).toEqual({ notBefore: "2026-10-29T00:05:00.000Z" });

    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(completedCount()).toBe(1);
  } finally {
    db.close();
    await f.close();
  }
});

it("defers a sweep after a write and resumes at the five-minute backoff", async () => {
  const f = await fixture(),
    db = new Database(join(f.dir, "workspace.sqlite"));
  try {
    const imported = await f.engine.command(ctx, {
      commandId: "trash-deferral-write",
      type: "vc.ImportContent",
      payload: { content: "recent write", format: "markdown", title: "recent write" },
    });
    expect(imported.ok).toBe(true);
    setNextSweepDue(db);
    const pending = await waitForPendingSweep(
      db,
      (job) =>
        field(job.payload, "notBefore") === "2026-10-28T00:05:00.000Z" &&
        field(job.payload, "deferredSince") === "2026-10-28T00:00:00.000Z" &&
        field(job.payload, "deferrals") === 1,
    );
    expect(pending.payload).toEqual({
      notBefore: "2026-10-28T00:05:00.000Z",
      deferredSince: "2026-10-28T00:00:00.000Z",
      deferrals: 1,
    });
  } finally {
    db.close();
    await f.close();
  }
});

it("defers a sweep while any other outbox job is leased", async () => {
  const f = await fixture(),
    db = new Database(join(f.dir, "workspace.sqlite"));
  try {
    db.prepare("INSERT INTO sys_outbox VALUES(?,?,?,?,?)").run(
      "leased-agent",
      "agent.reply",
      "leased",
      "2026-10-28T00:01:00.000Z",
      JSON.stringify({
        id: "leased-agent",
        kind: "agent.reply",
        payload: {},
        state: "leased",
        leaseUntil: "2026-10-28T00:01:00.000Z",
        attempts: 1,
        createdAt: "2026-10-28T00:00:00.000Z",
      }),
    );
    setNextSweepDue(db);
    const pending = await waitForPendingSweep(
      db,
      (job) =>
        field(job.payload, "notBefore") === "2026-10-28T00:05:00.000Z" &&
        field(job.payload, "deferredSince") === "2026-10-28T00:00:00.000Z",
    );
    expect(field(pending.payload, "deferrals")).toBe(1);
  } finally {
    db.close();
    await f.close();
  }
});

it("does not treat a client subscription, queries or an idle connected MCP server as busy", async () => {
  const f = await fixture(),
    db = new Database(join(f.dir, "workspace.sqlite")),
    iterator = f.engine.subscribe(ctx, { afterSeq: 999_999 })[Symbol.asyncIterator]();
  try {
    await f.engine.query(ctx, { name: "vc.Artifacts", args: {} });
    db.prepare("INSERT INTO vc_feedback(kind,id,json) VALUES(?,?,?)").run(
      "tool-server",
      "idle-mcp",
      JSON.stringify({
        serverId: "idle-mcp",
        name: "Idle MCP",
        transport: { kind: "http", url: "http://localhost:4567/mcp" },
        scope: {},
        status: "connected",
        tools: [],
        policies: {},
        updatedAt: "2026-10-28T00:00:00.000Z",
      }),
    );
    const nextEvent = iterator.next();
    setNextSweepDue(db);
    await waitForCompletedSweep(db);
    expect(await dbCount(db, "trash.sweep", "completed")).toBe(1);
    await iterator.return?.();
    void nextEvent;
  } finally {
    await iterator.return?.();
    db.close();
    await f.close();
  }
});

it("forces an overdue sweep after the 24-hour deferral cap", async () => {
  const f = await fixture(),
    db = new Database(join(f.dir, "workspace.sqlite"));
  try {
    const imported = await f.engine.command(ctx, {
      commandId: "trash-force-import",
      type: "vc.ImportContent",
      payload: { content: "expired content", format: "markdown", title: "Expired" },
    });
    if (!imported.ok) throw new Error(imported.error.message);
    const artifactId = new Contract().read<{ artifactId: string }>(
        "operations/vc.ImportContent",
        imported.result,
        "#/properties/result",
      ).artifactId,
      trashed = await f.engine.command(ctx, {
        commandId: "trash-force-trash",
        type: "vc.Trash",
        payload: { target: { kind: "artifact", id: artifactId } },
      });
    expect(trashed.ok).toBe(true);
    advanceClock(31 * 24 * 60 * 60_000);
    db.prepare("INSERT INTO sys_outbox VALUES(?,?,?,?,?)").run(
      "leased-agent",
      "agent.reply",
      "leased",
      "2026-11-30T00:00:00.000Z",
      JSON.stringify({
        id: "leased-agent",
        kind: "agent.reply",
        payload: {},
        state: "leased",
        leaseUntil: "2026-11-30T00:00:00.000Z",
        attempts: 1,
        createdAt: "2026-11-29T00:00:00.000Z",
      }),
    );
    rewriteNextSweep(db, {
      notBefore: "2026-11-28T00:00:00.000Z",
      deferredSince: "2026-11-27T00:00:00.000Z",
      deferrals: 30,
    });
    await waitUntil(async () => {
      try {
        await f.engine.query(ctx, { name: "vc.Artifact", args: { artifactId, includeTrashed: true } });
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    db.close();
    await f.close();
  }
});

it("prunes completed trash-sweep ticks when the engine starts", async () => {
  const f = await fixture();
  try {
    await f.engine.stop();
    const db = new Database(join(f.dir, "workspace.sqlite"));
    try {
      const insert = db.prepare("INSERT INTO sys_outbox VALUES(?,?,?,?,?)");
      for (const id of ["old-sweep-one", "old-sweep-two"])
        insert.run(
          id,
          "trash.sweep",
          "completed",
          null,
          JSON.stringify({
            id,
            kind: "trash.sweep",
            payload: {},
            state: "completed",
            leaseUntil: null,
            attempts: 1,
            createdAt: "2026-10-28T00:00:00.000Z",
          }),
        );
      rewriteNextSweep(
        db,
        { notBefore: "2026-10-27T00:00:00.000Z", deferredSince: "2026-10-26T00:00:00.000Z", deferrals: 4 },
        "leased",
      );
    } finally {
      db.close();
    }
    await f.engine.start(f.dir);
    const readDb = new Database(join(f.dir, "workspace.sqlite"), { readonly: true });
    try {
      const row: unknown = readDb
        .prepare("SELECT count(*) AS count FROM sys_outbox WHERE kind='trash.sweep' AND state='completed'")
        .get();
      expect(row !== null && typeof row === "object" ? Reflect.get(row, "count") : undefined).toBe(0);
      const rescheduled: unknown = readDb
        .prepare("SELECT json FROM sys_outbox WHERE kind='trash.sweep' AND state='pending'")
        .get();
      const raw =
        rescheduled !== null && typeof rescheduled === "object" ? Reflect.get(rescheduled, "json") : undefined;
      expect(typeof raw).toBe("string");
      expect(JSON.parse(String(raw))).toMatchObject({ payload: { notBefore: "2026-10-28T00:05:00.000Z" } });
    } finally {
      readDb.close();
    }
  } finally {
    await f.close();
  }
});

function setNextSweepDue(db: Database.Database): void {
  rewriteNextSweep(db, { notBefore: "2026-10-28T00:00:00.000Z" });
}
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
function rewriteNextSweep(
  db: Database.Database,
  payload: Record<string, string | number>,
  state: "pending" | "leased" = "pending",
): void {
  const row: unknown = db.prepare("SELECT json FROM sys_outbox WHERE kind='trash.sweep' AND state='pending'").get();
  if (!row || typeof row !== "object") throw new Error("No pending trash sweep");
  const raw = Reflect.get(row, "json");
  if (typeof raw !== "string") throw new Error("Invalid trash sweep row");
  const parsed: unknown = JSON.parse(raw),
    current = new Contract().read<Job>("job", parsed),
    job = new Contract().read<Job>("job", {
      ...current,
      payload,
      state,
      leaseUntil: state === "leased" ? "2026-10-28T00:00:30.000Z" : null,
      attempts: state === "leased" ? 1 : 0,
    });
  db.prepare("UPDATE sys_outbox SET state=?,lease_until=?,json=? WHERE id=?").run(
    job.state,
    job.leaseUntil,
    JSON.stringify(job),
    job.id,
  );
}
async function waitForPendingSweep(db: Database.Database, predicate: (job: Job) => boolean): Promise<Job> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row: unknown = db.prepare("SELECT json FROM sys_outbox WHERE kind='trash.sweep' AND state='pending'").get();
    if (row && typeof row === "object") {
      const raw = Reflect.get(row, "json");
      if (typeof raw === "string") {
        const parsed: unknown = JSON.parse(raw),
          job = new Contract().read<Job>("job", parsed);
        if (predicate(job)) return job;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Trash sweep did not reschedule");
}
async function waitForCompletedSweep(db: Database.Database): Promise<void> {
  await waitUntil(async () => (await dbCount(db, "trash.sweep", "completed")) > 0);
}
async function dbCount(db: Database.Database, kind: string, state: string): Promise<number> {
  const row: unknown = db.prepare("SELECT count(*) AS count FROM sys_outbox WHERE kind=? AND state=?").get(kind, state);
  return row && typeof row === "object" && typeof Reflect.get(row, "count") === "number"
    ? Reflect.get(row, "count")
    : 0;
}
async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition did not become true");
}
