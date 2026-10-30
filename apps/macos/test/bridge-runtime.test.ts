import { expect, it, vi } from "vitest";
import { reconnectEvents, retryUnauthenticated } from "../src/bridge-runtime.js";

it("retries an unauthenticated command once with its original id and exposes a second failure", async () => {
  const command = { commandId: "same-action-id", type: "vc.CaptureIdea", payload: { text: "idea" } },
    ids: string[] = [],
    recover = vi.fn(async () => undefined);
  let attempts = 0;
  const first = await retryUnauthenticated(async () => {
    ids.push(command.commandId);
    attempts++;
    return attempts === 1 ? { ok: false as const, error: { code: "unauthenticated" } } : { ok: true as const };
  }, recover);
  expect(first).toEqual({ ok: true });
  expect(ids).toEqual([command.commandId, command.commandId]);
  expect(recover).toHaveBeenCalledTimes(1);

  attempts = 0;
  const secondRecovery = vi.fn(async () => undefined),
    second = await retryUnauthenticated(async () => {
      attempts++;
      return { ok: false as const, error: { code: "unauthenticated" } };
    }, secondRecovery);
  expect(second).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  expect(attempts).toBe(2);
  expect(secondRecovery).toHaveBeenCalledTimes(1);
});

it("reconnects from the last sequence, drops a duplicate, and emits no gap", async () => {
  const controller = new AbortController(),
    cursors: number[] = [],
    seen: number[] = [];
  let attempt = 0;
  const subscribe = async function* (cursor: number) {
    cursors.push(cursor);
    attempt++;
    if (attempt === 1) {
      yield { seq: 6 };
      yield { seq: 7 };
      throw new Error("connection dropped");
    }
    yield { seq: 7 };
    yield { seq: 8 };
  };
  for await (const event of reconnectEvents(5, controller.signal, subscribe, async () => undefined, 0)) {
    seen.push(event.seq);
    if (event.seq === 8) controller.abort();
  }
  expect(cursors).toEqual([5, 7]);
  expect(seen).toEqual([6, 7, 8]);
});
