import { expect, it } from "vitest";
import fc from "fast-check";
import type { CallLog } from "../src/gateway/types.js";
import { usageStats } from "../src/gateway/stats.js";
import { ctx, fixture } from "./helpers.js";

// W11: usage stats come from the call records alone; groups always add up to the totals.

const call = (over: Partial<CallLog> & Pick<CallLog, "callId" | "createdAt">): CallLog => ({
  alias: "default",
  model: "m1",
  reservationId: over.callId,
  reservedMicros: 100,
  settledMicros: 40,
  usageQuality: "reported",
  finishReason: "stop",
  durationMs: 100,
  ...over,
});
const utcDay = (iso: string) => iso.slice(0, 10);
const range = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z" };

it("totals and groups calls in a range by day, agent, model, session and purpose", () => {
  const calls = [
    call({
      callId: "a",
      createdAt: "2026-11-02T10:00:00.000Z",
      agentId: "vibecab",
      sessionId: "s1",
      purpose: "reply",
      inputTokens: 100,
      outputTokens: 20,
      durationMs: 100,
    }),
    call({
      callId: "b",
      createdAt: "2026-11-02T11:00:00.000Z",
      agentId: "vibecab",
      sessionId: "s2",
      purpose: "update",
      inputTokens: 300,
      outputTokens: 50,
      cachedInputTokens: 200,
      durationMs: 300,
      model: "m2",
    }),
    // Usage unknown: it still counts what was reserved, and an error is an error.
    call({
      callId: "c",
      createdAt: "2026-11-03T09:00:00.000Z",
      agentId: "claude-code",
      purpose: "reply",
      settledMicros: undefined,
      errorCode: "timeout",
      finishReason: "error",
      durationMs: 900,
    }),
    // Outside the range.
    call({ callId: "d", createdAt: "2026-10-31T23:59:59.000Z", agentId: "vibecab" }),
    call({ callId: "e", createdAt: "2026-11-08T00:00:00.000Z", agentId: "vibecab" }),
  ];
  const byDay = usageStats(calls, { ...range, groupBy: "day", dayOf: utcDay });
  expect(byDay.totals).toEqual({
    calls: 3,
    costMicros: 40 + 40 + 100,
    inputTokens: 400,
    outputTokens: 70,
    cachedInputTokens: 200,
    errors: 1,
    medianDurationMs: 300,
    p95DurationMs: 900,
  });
  expect(byDay.groups.map((g) => [g.key, g.calls, g.costMicros])).toEqual([
    ["2026-11-02", 2, 80],
    ["2026-11-03", 1, 100],
  ]);
  // Older records have no agent, session or purpose: they group under "".
  expect(usageStats(calls, { ...range, groupBy: "agent", dayOf: utcDay }).groups.map((g) => [g.key, g.calls])).toEqual([
    ["claude-code", 1],
    ["vibecab", 2],
  ]);
  expect(usageStats(calls, { ...range, groupBy: "session", dayOf: utcDay }).groups.map((g) => g.key)).toEqual([
    "",
    "s1",
    "s2",
  ]);
  expect(usageStats(calls, { ...range, groupBy: "model", dayOf: utcDay }).groups.map((g) => g.key)).toEqual([
    "m1",
    "m2",
  ]);
  expect(usageStats([], { ...range, groupBy: "purpose", dayOf: utcDay })).toEqual({
    totals: {
      calls: 0,
      costMicros: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      errors: 0,
      medianDurationMs: 0,
      p95DurationMs: 0,
    },
    groups: [],
  });
});

it("always has groups that add up to the totals", () => {
  const arbitraryCall = fc.record({
    day: fc.integer({ min: 0, max: 9 }),
    agentId: fc.constantFrom("vibecab", "claude-code", undefined),
    sessionId: fc.constantFrom("s1", "s2", undefined),
    purpose: fc.constantFrom("reply", "update", "digest", undefined),
    model: fc.constantFrom("m1", "m2"),
    settled: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: undefined }),
    input: fc.option(fc.integer({ min: 0, max: 50_000 }), { nil: undefined }),
    output: fc.option(fc.integer({ min: 0, max: 5_000 }), { nil: undefined }),
    duration: fc.integer({ min: 0, max: 60_000 }),
    failed: fc.boolean(),
  });
  fc.assert(
    fc.property(
      fc.array(arbitraryCall, { maxLength: 40 }),
      fc.constantFrom("day", "agent", "model", "session", "purpose" as const),
      (raw, groupBy) => {
        const calls = raw.map((c, i) =>
          call({
            callId: "c" + i,
            createdAt: new Date(Date.parse("2026-10-30T12:00:00.000Z") + c.day * 86_400_000).toISOString(),
            model: c.model,
            settledMicros: c.settled,
            durationMs: c.duration,
            ...(c.agentId ? { agentId: c.agentId } : {}),
            ...(c.sessionId ? { sessionId: c.sessionId } : {}),
            ...(c.purpose ? { purpose: c.purpose as CallLog["purpose"] } : {}),
            ...(c.input !== undefined ? { inputTokens: c.input } : {}),
            ...(c.output !== undefined ? { outputTokens: c.output } : {}),
            ...(c.failed ? { errorCode: "provider_error" } : {}),
          }),
        );
        const { totals, groups } = usageStats(calls, { ...range, groupBy, dayOf: utcDay });
        const sum = (field: "calls" | "costMicros" | "inputTokens" | "outputTokens" | "cachedInputTokens" | "errors") =>
          groups.reduce((n, g) => n + g[field], 0);
        for (const field of [
          "calls",
          "costMicros",
          "inputTokens",
          "outputTokens",
          "cachedInputTokens",
          "errors",
        ] as const)
          expect(sum(field)).toBe(totals[field]);
        expect(totals.p95DurationMs).toBeGreaterThanOrEqual(totals.medianDurationMs);
        expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
      },
    ),
  );
});

it("answers sys.UsageStats through the contract", async () => {
  const f = await fixture();
  try {
    expect(
      await f.engine.query(ctx, {
        name: "sys.UsageStats",
        args: { from: "2026-10-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z", groupBy: "agent" },
      }),
    ).toMatchObject({ totals: { calls: 0 }, groups: [] });
    expect(
      await f.engine
        .query(ctx, { name: "sys.UsageStats", args: { from: "x", to: "y", groupBy: "agent" } })
        .catch((e) => e),
    ).toMatchObject({ contract: { code: "invalid" } });
  } finally {
    await f.close();
  }
});
