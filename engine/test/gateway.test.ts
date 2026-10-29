import { expect, it } from "vitest";
import fc from "fast-check";
import { Contract } from "../../contract/src/index.js";
import type { Json } from "../../contract/src/index.js";
import { BudgetLedger, estimateInputTokens, estimateReservationMicros } from "../src/gateway/ledger.js";
import { MemoryKeyStore } from "../src/gateway/keys.js";
import { ProviderGateway } from "../src/gateway/gateway.js";
import { ScriptedProvider } from "../src/gateway/fake.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import { OpenAICompatibleProvider } from "../src/gateway/providers/openai-compatible.js";
import { JobRunner } from "../src/kernel/jobs.js";
import type { ModelEvent, ProviderModel } from "../src/gateway/types.js";
import { clock, ctx, fixture } from "./helpers.js";

const caps = {
  tools: true,
  jsonSchemaOutput: true,
  streaming: true,
  maxContextTokens: 4096,
  reportsUsage: true,
};
const model: ProviderModel = {
  provider: "openai-compatible",
  baseUrl: "https://model.example.test/v1",
  model: "fake-model",
  keyRef: "test-key",
  capabilities: caps,
  pricing: {
    inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 1_000_000,
  },
};
function setup(limits = 1000) {
  const contract = new Contract(),
    store = new SqliteStore(":memory:", contract),
    ledger = new BudgetLedger(store, clock, contract);
  ledger.setLimit({ kind: "daily", key: "2026-10-28" }, limits);
  ledger.setLimit({ kind: "session", key: "s" }, limits);
  ledger.setLimit({ kind: "grant", key: "g" }, limits);
  ledger.setLimit({ kind: "run", key: "r" }, limits);
  ledger.setLimit({ kind: "turn", key: "t" }, limits);
  return { contract, store, ledger, close: () => store.close() };
}
const request = {
  modelRef: "default",
  messages: [{ role: "user" as const, content: "Hello" }],
  maxOutputTokens: 16,
};

it("gates capabilities before calling the provider and validates structured output", async () => {
  const f = setup(),
    provider = new ScriptedProvider();
  try {
    f.ledger.reserve("r1", [{ kind: "daily", key: "2026-10-28" }], 100);
    const gateway = new ProviderGateway(
      {
        default: {
          ...model,
          capabilities: { ...caps, jsonSchemaOutput: false },
        },
      },
      { "openai-compatible": provider },
      f.ledger,
      f.contract,
    );
    await expect(async () => {
      for await (const _ of gateway.call(
        {
          ...request,
          output: {
            kind: "json",
            schema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            },
            name: "result",
          },
        },
        { reservationId: "r1", signal: new AbortController().signal },
      ))
        void _;
    }).rejects.toMatchObject({ contract: { code: "unsupported" } });
    expect(provider.calls).toHaveLength(0);
    const invalid: ModelEvent[] = [{ type: "output", json: { ok: "not boolean" } }];
    provider.enqueue("r2", invalid);
    f.ledger.reserve("r2", [{ kind: "daily", key: "2026-10-28" }], 100);
    const validModel = new ProviderGateway({ default: model }, { "openai-compatible": provider }, f.ledger, f.contract);
    const events: ModelEvent[] = [];
    for await (const event of validModel.call(
      {
        ...request,
        output: {
          kind: "json",
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
          name: "result",
        },
      },
      {
        reservationId: "r2",
        signal: new AbortController().signal,
        idempotencyKey: "r2",
      },
    ))
      events.push(event);
    expect(events).toEqual([
      {
        type: "error",
        code: "provider_error",
        message: "Model returned invalid structured output",
        retryable: false,
      },
    ]);
    expect(f.ledger.calls()).toMatchObject([
      {
        usageQuality: "unknown",
        errorCode: "provider_error",
        settledMicros: 100,
      },
    ]);
  } finally {
    f.close();
  }
});

it("requires an existing budget reservation and propagates cancellation to the fake provider", async () => {
  const f = setup(),
    provider = new ScriptedProvider();
  try {
    const gateway = new ProviderGateway({ default: model }, { "openai-compatible": provider }, f.ledger, f.contract);
    await expect(async () => {
      for await (const _ of gateway.call(request, {
        reservationId: "missing",
        signal: new AbortController().signal,
      }))
        void _;
    }).rejects.toMatchObject({ contract: { code: "budget_exceeded" } });
    f.ledger.reserve("r1", [{ kind: "daily", key: "2026-10-28" }], 100);
    const controller = new AbortController();
    controller.abort();
    const events: ModelEvent[] = [];
    for await (const event of gateway.call(request, {
      reservationId: "r1",
      signal: controller.signal,
    }))
      events.push(event);
    expect(events).toMatchObject([{ type: "error", code: "cancelled" }]);
    expect(provider.calls).toHaveLength(1);
    f.ledger.reserve("r2", [{ kind: "daily", key: "2026-10-28" }], 100);
    provider.enqueueHang("hang");
    const hangingController = new AbortController();
    const hangingResponse = gateway.call(request, {
      reservationId: "r2",
      idempotencyKey: "hang",
      signal: hangingController.signal,
    });
    const iterator = hangingResponse[Symbol.asyncIterator]();
    const next = iterator.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    hangingController.abort();
    expect(await next).toMatchObject({
      done: false,
      value: { type: "error", code: "cancelled" },
    });
    await iterator.return?.();
    expect(f.ledger.reservation("r2")).toMatchObject({
      state: "uncertain",
      usageQuality: "unknown",
    });
  } finally {
    f.close();
  }
});

it("reserves against every account, settles reported cost, and keeps unknown reservations charged", () => {
  const f = setup(100);
  try {
    f.ledger.reserve(
      "one",
      [
        { kind: "daily", key: "2026-10-28" },
        { kind: "session", key: "s" },
        { kind: "turn", key: "t" },
      ],
      60,
    );
    expect(estimateInputTokens(request)).toBe(
      Math.ceil(JSON.stringify({ messages: request.messages, tools: [], output: null }).length / 3),
    );
    expect(estimateReservationMicros(request, model)).toBe(estimateInputTokens(request) + request.maxOutputTokens);
    expect(() => f.ledger.reserve("two", [{ kind: "session", key: "s" }], 50)).toThrow(
      expect.objectContaining({
        contract: expect.objectContaining({ code: "budget_exceeded" }),
      }),
    );
    f.ledger.settle("one", 35, "reported");
    expect(f.ledger.state({ kind: "daily", key: "2026-10-28" })).toMatchObject({
      usedMicros: 35,
      reservedMicros: 0,
    });
    f.ledger.reserve("unknown", [{ kind: "daily", key: "2026-10-28" }], 40);
    f.ledger.markUncertain("unknown");
    expect(f.ledger.state({ kind: "daily", key: "2026-10-28" })).toMatchObject({
      usedMicros: 35,
      reservedMicros: 40,
    });
  } finally {
    f.close();
  }
});

it("marks a lost model-call lease uncertain and retains its budget reservation", async () => {
  const f = setup(100),
    now = clock.now();
  try {
    f.ledger.reserve("lost-reservation", [{ kind: "daily", key: "2026-10-28" }], 80);
    f.store.transaction(() => {
      f.store.enqueue("model.call", "lost-job", { reservationId: "lost-reservation" }, now);
      f.store.lease("lost-job", "2026-10-28T00:01:00.000Z");
    });
    const runner = new JobRunner(f.store, clock, (action) => Promise.resolve(f.store.transaction(action)), {
      leaseMs: 1000,
      handlers: {},
      onUncertain: (job) => {
        const payload = job.payload;
        if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
          const id = Reflect.get(payload, "reservationId");
          if (typeof id === "string") f.ledger.markUncertain(id);
        }
      },
    });
    await runner.recover();
    expect(f.store.jobs()[0]).toMatchObject({ state: "uncertain" });
    expect(f.ledger.reservation("lost-reservation")).toMatchObject({
      state: "uncertain",
      usageQuality: "unknown",
    });
    expect(f.ledger.state({ kind: "daily", key: "2026-10-28" })).toMatchObject({
      reservedMicros: 80,
    });
  } finally {
    f.close();
  }
});

it("preserves nested budget ceilings for random reservations, settlements, and unknown calls", () =>
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.nat(80), fc.nat(80), fc.integer({ min: 0, max: 2 })), { maxLength: 30 }),
      (triples) => {
        const f = setup(100);
        try {
          const scopes = [
            { kind: "daily" as const, key: "2026-10-28" },
            { kind: "session" as const, key: "s" },
            { kind: "grant" as const, key: "g" },
            { kind: "run" as const, key: "r" },
            { kind: "turn" as const, key: "t" },
          ];
          triples.forEach(([reserve, settle, quality], index) => {
            const amount = reserve + 1,
              id = "r-" + index;
            try {
              f.ledger.reserve(id, scopes, amount);
              for (const scope of scopes) {
                const before = f.ledger.state(scope);
                expect(before.usedMicros + before.reservedMicros).toBeLessThanOrEqual(100);
              }
              if (quality === 2) f.ledger.markUncertain(id);
              else f.ledger.settle(id, Math.min(settle, amount), quality === 0 ? "reported" : "estimated");
            } catch (error) {
              expect(error).toMatchObject({
                contract: { code: "budget_exceeded" },
              });
            }
            for (const scope of scopes) {
              const after = f.ledger.state(scope);
              expect(after.usedMicros + after.reservedMicros).toBeLessThanOrEqual(100);
            }
          });
        } finally {
          f.close();
        }
      },
    ),
    { seed: 20261029, numRuns: 20, verbose: true },
  ));

it("keeps model keys in the key store and settings contain only references", async () => {
  const keys = new MemoryKeyStore(),
    secret = "known-test-secret";
  await keys.set("provider:test", secret);
  expect(await keys.get("provider:test")).toBe(secret);
  const f = setup();
  try {
    f.store.transaction(() =>
      f.store.saveFeedback(
        "settings",
        "workspace",
        f.contract.read("json", {
          models: { default: model },
          budgets: {},
          sessions: {},
        }),
      ),
    );
    const persisted =
      JSON.stringify(f.store.feedbackList("settings")) +
      JSON.stringify(f.store.eventsAfter(0)) +
      JSON.stringify(f.store.callLogs());
    expect(persisted).not.toContain(secret);
    await keys.delete("provider:test");
    await expect(keys.get("provider:test")).rejects.toMatchObject({
      contract: { code: "not_found" },
    });
  } finally {
    f.close();
  }
});

it("validates and persists settings, key references, budget limits, usage and budget queries", async () => {
  const f = await fixture();
  try {
    const saved = await f.engine.command(ctx, {
      commandId: "settings",
      type: "sys.SetSettings",
      payload: new Contract().read<Json>("json", {
        patch: {
          models: { default: model },
          budgets: { localTimeZone: "UTC", defaultTurnLimitMicros: 500 },
          sessions: {},
        },
      }),
    });
    expect(saved.ok).toBe(true);
    expect(
      await f.engine.command(
        { ...ctx, channel: "mcp" },
        {
          commandId: "mcp-admin",
          type: "sys.SetSettings",
          payload: { patch: {} },
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(
      (
        await f.engine.command(ctx, {
          commandId: "key-ref",
          type: "sys.SetProviderKeyRef",
          payload: { alias: "default", keyRef: "provider:default" },
        })
      ).ok,
    ).toBe(true);
    expect(await f.engine.query(ctx, { name: "sys.Settings", args: {} })).toMatchObject({
      models: { default: { keyRef: "provider:default" } },
      budgets: { localTimeZone: "UTC" },
    });
    const budget = await f.engine.command(ctx, {
      commandId: "limit",
      type: "sys.SetBudget",
      payload: { account: { kind: "turn", key: "t" }, limitMicros: 500 },
    });
    expect(budget.ok).toBe(true);
    expect(await f.engine.query(ctx, { name: "sys.Budgets", args: {} })).toMatchObject([
      { account: { kind: "turn", key: "t" }, limitMicros: 500 },
    ]);
    expect(await f.engine.query(ctx, { name: "sys.Usage", args: {} })).toMatchObject({ calls: [] });
  } finally {
    await f.close();
  }
});

it("maps recorded OpenAI-compatible JSON streaming requests and responses without network access", async () => {
  const keys = new MemoryKeyStore(),
    captured: Array<{ url: string; body: string }> = [];
  await keys.set("test-key", "fixture-secret");
  const chunks = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "fake-model",
      choices: [{ index: 0, delta: { content: '{"ok":true}' }, finish_reason: null }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "fake-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
  ];
  const fetcher: typeof fetch = async (input, init) => {
    captured.push({ url: String(input), body: String(init?.body ?? "") });
    const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const provider = new OpenAICompatibleProvider(keys, fetcher),
    outputSchema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    } as const;
  const events: ModelEvent[] = [];
  for await (const event of provider.call(
    model,
    {
      ...request,
      output: { kind: "json", schema: outputSchema, name: "result" },
    },
    { reservationId: "r", signal: new AbortController().signal },
  ))
    events.push(event);
  expect(captured[0]!.url).toBe("https://model.example.test/v1/chat/completions");
  expect(JSON.parse(captured[0]!.body)).toMatchObject({
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: "json_schema", json_schema: { name: "result" } },
  });
  expect(events).toEqual([
    { type: "usage", inputTokens: 3, outputTokens: 1, quality: "reported" },
    { type: "output", json: { ok: true } },
    { type: "done", finishReason: "stop" },
  ]);
});

it("maps streamed OpenAI tool call deltas from recorded fixtures", async () => {
  const keys = new MemoryKeyStore();
  await keys.set("test-key", "fixture-secret");
  const chunks = [
    {
      id: "chatcmpl-tools",
      object: "chat.completion.chunk",
      created: 1,
      model: "fake-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name: "read_", arguments: '{"id":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-tools",
      object: "chat.completion.chunk",
      created: 1,
      model: "fake-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                type: "function",
                function: { name: "elements", arguments: '"el-1"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ];
  const fetcher: typeof fetch = async () =>
    new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  const provider = new OpenAICompatibleProvider(keys, fetcher),
    events: ModelEvent[] = [];
  const toolRequest = {
    ...request,
    tools: [
      {
        name: "read_elements",
        description: "Read blocks",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ],
  };
  for await (const event of provider.call(model, toolRequest, {
    reservationId: "r",
    signal: new AbortController().signal,
  }))
    events.push(event);
  expect(events).toMatchObject([
    {
      type: "tool_call",
      call: { id: "call-1", name: "read_elements", arguments: { id: "el-1" } },
    },
    { type: "done", finishReason: "tool_calls" },
  ]);
});
