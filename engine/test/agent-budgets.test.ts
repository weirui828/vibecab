import { afterEach, expect, it } from "vitest";
import { Contract } from "../../contract/src/index.js";
import { BudgetLedger } from "../src/gateway/ledger.js";
import { ProviderGateway } from "../src/gateway/gateway.js";
import { ScriptedProvider } from "../src/gateway/fake.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import type { ProviderModel } from "../src/gateway/types.js";
import { advanceClock, clock, ctx, fixture, resetClock } from "./helpers.js";

// W10: per-agent daily limits beside the overall one, limits that last past the day they were set, and calls recorded
// with who made them and how many tokens they used.

const DAY = 24 * 60 * 60 * 1000;
const model: ProviderModel = {
  provider: "openai-compatible",
  baseUrl: "https://model.example.test/v1",
  model: "fake-model",
  keyRef: "test-key",
  capabilities: { tools: true, jsonSchemaOutput: true, streaming: true, maxContextTokens: 4096, reportsUsage: true },
  pricing: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 },
};
function setup() {
  const contract = new Contract(),
    store = new SqliteStore(":memory:", contract),
    ledger = new BudgetLedger(store, clock, contract, () => "UTC");
  return { contract, store, ledger };
}
const exceeded = expect.objectContaining({ contract: expect.objectContaining({ code: "budget_exceeded" }) });
afterEach(() => resetClock());

it("keeps the daily limit for every day after it is set, not just the day it was set", () => {
  const { ledger, store } = setup();
  try {
    ledger.setLimit({ kind: "daily" }, 100);
    ledger.reserve("today", [{ kind: "daily" }], 80);
    expect(() => ledger.reserve("over", [{ kind: "daily" }], 30)).toThrow(exceeded);
    advanceClock(DAY);
    // A new day starts empty, under the same limit.
    ledger.reserve("tomorrow", [{ kind: "daily" }], 90);
    expect(() => ledger.reserve("tomorrow-over", [{ kind: "daily" }], 20)).toThrow(exceeded);
    // Lifting the limit lifts it for good.
    ledger.setLimit({ kind: "daily" }, null);
    advanceClock(DAY);
    ledger.reserve("free", [{ kind: "daily" }], 10_000);
  } finally {
    store.close();
  }
});

it("limits one agent per day without touching another, and reports today per agent", () => {
  const { ledger, store } = setup();
  try {
    ledger.setLimit({ kind: "agent", key: "vibecab" }, 50);
    ledger.reserve("a", [{ kind: "daily" }, { kind: "agent", key: "vibecab" }], 40);
    expect(() => ledger.reserve("b", [{ kind: "daily" }, { kind: "agent", key: "vibecab" }], 20)).toThrow(exceeded);
    ledger.reserve("c", [{ kind: "daily" }, { kind: "agent", key: "claude-code" }], 20);
    ledger.settle("a", 30, "reported");
    expect(ledger.today()).toEqual({
      date: "2026-10-28",
      daily: { limitMicros: null, usedMicros: 30, reservedMicros: 20 },
      agents: [
        { agentId: "claude-code", limitMicros: null, usedMicros: 0, reservedMicros: 20 },
        { agentId: "vibecab", limitMicros: 50, usedMicros: 30, reservedMicros: 0 },
      ],
    });
    advanceClock(DAY);
    // The agent's limit carries over; its use starts again.
    expect(ledger.today().agents).toContainEqual({
      agentId: "vibecab",
      limitMicros: 50,
      usedMicros: 0,
      reservedMicros: 0,
    });
    expect(() => ledger.reserve("d", [{ kind: "agent", key: "vibecab" }], 60)).toThrow(exceeded);
    // The built-in agent is always listed, even before it has spent anything.
    const fresh = setup();
    expect(fresh.ledger.today().agents).toEqual([
      { agentId: "vibecab", limitMicros: null, usedMicros: 0, reservedMicros: 0 },
    ]);
    fresh.store.close();
  } finally {
    store.close();
  }
});

it("records who made a call, what for, and how many tokens it used", async () => {
  const { ledger, store, contract } = setup();
  try {
    const provider = new ScriptedProvider();
    provider.enqueueDefaultSequence([
      [
        { type: "text_delta", text: "Hi" },
        { type: "usage", inputTokens: 12, outputTokens: 7, quality: "reported" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const gateway = new ProviderGateway({ default: model }, { "openai-compatible": provider }, ledger, contract, clock);
    ledger.reserve("call-1", [{ kind: "daily" }, { kind: "agent", key: "vibecab" }], 1000);
    for await (const event of gateway.call(
      { modelRef: "default", messages: [{ role: "user", content: "Hello" }], maxOutputTokens: 16 },
      {
        reservationId: "call-1",
        signal: new AbortController().signal,
        attribution: { agentId: "vibecab", sessionId: "session_1", purpose: "reply" },
      },
    ))
      void event;
    expect(ledger.calls()).toEqual([
      expect.objectContaining({
        callId: "call-1",
        agentId: "vibecab",
        sessionId: "session_1",
        purpose: "reply",
        inputTokens: 12,
        outputTokens: 7,
        settledMicros: 19,
      }),
    ]);
  } finally {
    store.close();
  }
});

it("sets an agent's limit and reads today's spending through the contract", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.engine.command(ctx, {
          commandId: "agent-limit",
          type: "sys.SetBudget",
          payload: { account: { kind: "agent", key: "vibecab" }, limitMicros: 2_000_000 },
        })
      ).ok,
    ).toBe(true);
    expect(await f.engine.query(ctx, { name: "sys.SpendingToday", args: {} })).toMatchObject({
      daily: { usedMicros: 0 },
      agents: [{ agentId: "vibecab", limitMicros: 2_000_000, usedMicros: 0 }],
    });
  } finally {
    await f.close();
  }
});
