import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { Contract } from "../../contract/src/index.js";
import type { Job } from "../../contract/src/index.js";
import { fixture } from "./helpers.js";

it("schedules trash sweeps once daily instead of immediately rerunning them", async () => {
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
    expect(pending.payload).toEqual({ notBefore: "2026-10-29T00:00:00.000Z" });

    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(completedCount()).toBe(1);
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
    } finally {
      readDb.close();
    }
  } finally {
    await f.close();
  }
});
