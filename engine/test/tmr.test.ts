import { expect, it } from "vitest";
import fc from "fast-check";
import { Contract, type Json } from "../../contract/src/index.js";
import { stageContext, validateProcess } from "../src/tmr/process.js";
import type { ProcessSpec } from "../src/tmr/process.js";
import { fixture, ctx } from "./helpers.js";
import { ScriptedProvider } from "../src/gateway/fake.js";
import type { ProviderModel } from "../src/gateway/types.js";

const participant = { participantId: "a", roleLabel: "reviewer", modelRef: "demo", systemPromptHash: "a".repeat(64) };
function spec(): ProcessSpec {
  return {
    version: 1,
    maxStages: 2,
    onMissingContribution: "proceed_disclosed",
    stages: [
      {
        id: "assess",
        kind: "assess",
        participants: "all",
        inputs: ["snapshot"],
        outputSchema: { type: "object" },
        quorum: 1,
      },
      {
        id: "synthesize",
        kind: "synthesize",
        participants: "all",
        inputs: ["snapshot", "stage:assess"],
        outputSchema: { type: "object" },
        quorum: 1,
      },
    ],
  };
}

it("rejects cycles, forward references, missing synthesis, and stage overflow", () => {
  expect(() =>
    validateProcess(
      { ...spec(), stages: [spec().stages[0]!, { ...spec().stages[1]!, inputs: ["stage:synthesize"] }] },
      ["a"],
    ),
  ).toThrow();
  expect(() =>
    validateProcess(
      { ...spec(), stages: [spec().stages[0]!, { ...spec().stages[1]!, kind: "critique", inputs: ["stage:later"] }] },
      ["a"],
    ),
  ).toThrow();
  expect(() => validateProcess({ ...spec(), stages: [spec().stages[0]!] }, ["a"])).toThrow();
  expect(() => validateProcess({ ...spec(), maxStages: 1 }, ["a"])).toThrow();
});

it("keeps assess manifests isolated from peer contributions", () => {
  fc.assert(
    fc.property(fc.array(fc.string()), (texts) => {
      const peers = texts.map((privateText, index) => ({ participantId: String(index), privateText }));
      const manifest = stageContext(spec().stages[0]!, { items: [] }, { previous: peers });
      expect(JSON.stringify(manifest)).not.toContain("privateText");
      expect(JSON.stringify(manifest)).not.toContain("secret");
    }),
  );
  expect(() =>
    validateProcess(
      { ...spec(), stages: [{ ...spec().stages[0]!, inputs: ["snapshot", "stage:earlier"] }, spec().stages[1]!] },
      ["a"],
    ),
  ).toThrow();
});

const liveModel: ProviderModel = {
  provider: "openai-compatible",
  baseUrl: "https://example.invalid/v1",
  model: "fake-live",
  keyRef: "test-only",
  capabilities: {
    tools: false,
    jsonSchemaOutput: true,
    streaming: true,
    maxContextTokens: 4096,
    reportsUsage: false,
  },
  pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
};

it("runs live contributions through the gateway within the run budget", async () => {
  const provider = new ScriptedProvider();
  provider.enqueueDefaultSequence([
    [{ type: "output", json: { recommendation: "assessment" } }],
    [
      {
        type: "output",
        json: {
          recommendation: "synthesis",
          findings: [
            {
              findingId: "finding-1",
              concern: "Missing source",
              rationale: "The referenced input is not present",
              refs: [{ itemId: "missing-item" }],
              supportedBy: ["a"],
              opposedBy: [],
            },
          ],
        },
      },
    ],
  ]);
  const test = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    await test.engine.command(ctx, {
      commandId: "tmr-settings",
      type: "sys.SetSettings",
      payload: new Contract().read<Json>("json", { patch: { models: { default: liveModel } } }),
    });
    const raw = {
      requestId: "live-request",
      question: "Review this live",
      items: [{ itemId: "source-1", kind: "text", content: "material", source: "local" }],
      criteria: [],
      processSpec: spec(),
      participants: [{ ...participant, modelRef: "default" }],
      limits: { spendMicros: 1000 },
      mode: "live",
    };
    const submitted = await test.engine.command(ctx, {
      commandId: "tmr-live-submit",
      type: "tmr.Submit",
      payload: new Contract().read<Json>("json", raw),
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const runId = field(submitted.result, "runId");
    if (typeof runId !== "string") throw Error("TMR submit did not return a run id");
    const run = await waitForRun(test.engine, runId, "completed");
    expect(field(run, "mode")).toBe("live");
    expect(provider.calls).toHaveLength(2);
    const report = await test.engine.query(ctx, { name: "tmr.Report", args: { runId } });
    expect(new Contract().read<Json>("tmr/report", report)).toMatchObject({
      findings: [{ findingId: "finding-1", unresolved_reference: true }],
    });
  } finally {
    await test.close();
  }
});

it("stops live dispatch and reports limit_reached when the run budget is exhausted", async () => {
  const provider = new ScriptedProvider();
  provider.enqueueDefaultSequence([[{ type: "output", json: { recommendation: "assessment" } }]]);
  const test = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    await test.engine.command(ctx, {
      commandId: "tmr-budget-settings",
      type: "sys.SetSettings",
      payload: new Contract().read<Json>("json", { patch: { models: { default: liveModel } } }),
    });
    const submitted = await test.engine.command(ctx, {
      commandId: "tmr-budget-submit",
      type: "tmr.Submit",
      payload: new Contract().read<Json>("json", {
        requestId: "budget-request",
        question: "Bound spend",
        items: [{ itemId: "source-1", kind: "text", content: "material", source: "local" }],
        criteria: [],
        processSpec: spec(),
        participants: [{ ...participant, modelRef: "default" }],
        limits: { spendMicros: 1 },
        mode: "live",
      }),
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const runId = field(submitted.result, "runId");
    if (typeof runId !== "string") throw Error("TMR submit did not return a run id");
    const run = await waitForRun(test.engine, runId, "limit_reached");
    expect(field(run, "outcome")).toBe("limit_reached");
    expect(provider.calls).toHaveLength(1);
  } finally {
    await test.close();
  }
});

it("deduplicates identical TMR requests and rejects payload reuse", async () => {
  const test = await fixture();
  try {
    const rawPayload = {
      requestId: "same-request",
      question: "Review this",
      items: [{ itemId: "i1", kind: "text", content: "text", source: "local" }],
      criteria: [],
      processSpec: spec(),
      participants: [participant],
      limits: { spendMicros: 10000 },
      mode: "demo",
    };
    const payload = new Contract().read<Json>("json", rawPayload);
    const first = await test.engine.command(ctx, { commandId: "tmr-one", type: "tmr.Submit", payload });
    const second = await test.engine.command(ctx, { commandId: "tmr-two", type: "tmr.Submit", payload });
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) return;
    const runId = field(first.result, "runId");
    expect(field(second.result, "runId")).toBe(runId);
    const conflicting = await test.engine.command(ctx, {
      commandId: "tmr-three",
      type: "tmr.Submit",
      payload: new Contract().read<Json>("json", { ...rawPayload, question: "Changed" }),
    });
    expect(conflicting).toMatchObject({ ok: false, error: { code: "conflict" } });
    if (typeof runId !== "string") throw Error("TMR submit did not return a run id");
    let run: Json = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      run = await test.engine.query(ctx, { name: "tmr.Run", args: { runId } });
      if (field(run, "status") === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(field(run, "status")).toBe("completed");
    const report = await test.engine.query(ctx, { name: "tmr.Report", args: { runId } });
    expect(new Contract().read<Json>("tmr/report", report)).toMatchObject({
      runId,
      mode: "demo",
      outcome: "completed",
    });
    const events = await test.engine.query(ctx, { name: "tmr.Events", args: { runId } });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "stage_started" }),
        expect.objectContaining({ eventType: "contribution_recorded" }),
        expect.objectContaining({ eventType: "stage_completed" }),
      ]),
    );
  } finally {
    await test.close();
  }
});

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
}

async function waitForRun(
  engine: Awaited<ReturnType<typeof fixture>>["engine"],
  runId: string,
  expected: string,
): Promise<Json> {
  let run: Json = {};
  for (let attempt = 0; attempt < 100; attempt++) {
    run = await engine.query(ctx, { name: "tmr.Run", args: { runId } });
    if (field(run, "status") === expected) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return run;
}
