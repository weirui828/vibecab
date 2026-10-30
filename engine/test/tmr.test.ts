import { expect, it } from "vitest";
import fc from "fast-check";
import { Contract, type Json } from "../../contract/src/index.js";
import { stageContext, validateProcess } from "../src/tmr/process.js";
import type { ProcessSpec } from "../src/tmr/process.js";
import { fixture, ctx, clock } from "./helpers.js";
import { createEngine } from "../src/engine.js";
import { ScriptedProvider } from "../src/gateway/fake.js";
import type { ProviderModel } from "../src/gateway/types.js";
import type { ModelProvider } from "../src/gateway/types.js";
import { estimateInputTokens } from "../src/gateway/ledger.js";

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
  pricing: { inputMicrosPerMillion: 100_000, outputMicrosPerMillion: 100_000 },
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
            { findingId: "malformed" },
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
    for (const call of provider.calls) {
      const prompt = call.request.messages[0]?.content ?? "",
        user = call.request.messages[1]?.content ?? "",
        payload: unknown = JSON.parse(user),
        context = field(payload, "context");
      if (prompt.includes("Assess the supplied snapshot")) expect(keys(context)).toEqual(["snapshot"]);
      else {
        expect(prompt).toContain("Synthesize only the declared stage inputs");
        expect(keys(context)).toEqual(["assess", "snapshot"]);
      }
    }
    const report = await test.engine.query(ctx, { name: "tmr.Report", args: { runId } });
    expect(new Contract().read<Json>("tmr/report", report)).toMatchObject({
      recommendation: "synthesis",
      findings: [{ findingId: "finding-1", unresolved_reference: true }],
    });
    expect(field(report, "missingInformation")).toEqual(
      expect.arrayContaining([expect.stringContaining("did not match the report schema")]),
    );
    const runRecord = await test.engine.query(ctx, { name: "tmr.Run", args: { runId } });
    expect(keys(field(runRecord, "promptHashes"))).toEqual(["assess", "synthesize"]);
  } finally {
    await test.close();
  }
});

it("property-checks isolation from exact gateway requests across stage layouts", async () => {
  await fc.assert(
    fc.asyncProperty(fc.constantFrom("critique", "revise", "debate_round" as const), async (middleKind) => {
      const provider = new ScriptedProvider();
      provider.enqueueDefaultSequence(
        Array.from({ length: 4 }, (_, index) => [
          { type: "output" as const, json: { recommendation: "private-peer-contribution-" + index } },
        ]),
      );
      const test = await fixture({ modelProviders: { "openai-compatible": provider } });
      try {
        await setLiveModel(test.engine);
        const middleId = "middle",
          processSpec: ProcessSpec = {
            version: 1,
            maxStages: 3,
            onMissingContribution: "fail",
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
                id: middleId,
                kind: middleKind,
                participants: ["a"],
                inputs: ["stage:assess"],
                outputSchema: { type: "object" },
                quorum: 1,
              },
              {
                id: "synthesize",
                kind: "synthesize",
                participants: ["a"],
                inputs: ["stage:" + middleId],
                outputSchema: { type: "object" },
                quorum: 1,
              },
            ],
          },
          submitted = await submitLive(test.engine, "isolation-" + middleKind, processSpec, [
            participant,
            { ...participant, participantId: "b" },
          ]),
          runId = field(submitted, "runId");
        if (typeof runId !== "string") throw Error("TMR submit did not return a run id");
        await waitForRun(test.engine, runId, "completed");
        expect(provider.calls).toHaveLength(4);
        const actualKeys = new Set<string>();
        for (const call of provider.calls) {
          const system = call.request.messages[0]?.content ?? "",
            body = call.request.messages[1]?.content ?? "",
            parsed: unknown = JSON.parse(body),
            context = field(parsed, "context"),
            keysForStage = keys(context);
          if (system.startsWith("Assess")) {
            expect(keysForStage).toEqual(["snapshot"]);
            expect(body).not.toContain("private-peer-contribution");
            actualKeys.add("assess");
          } else if (system.startsWith("Synthesize")) {
            expect(keysForStage).toEqual([middleId]);
            actualKeys.add("synthesize");
          } else {
            expect(keysForStage).toEqual(["assess"]);
            actualKeys.add(middleKind);
          }
        }
        expect(actualKeys).toEqual(new Set(["assess", middleKind, "synthesize"]));
      } finally {
        await test.close();
      }
    }),
    { numRuns: 3 },
  );
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
    expect(provider.calls).toHaveLength(0);
  } finally {
    await test.close();
  }
});

it("keeps limit_reached after one participant succeeds and another exhausts the budget", async () => {
  const provider = new ScriptedProvider();
  provider.enqueueDefaultSequence([[{ type: "output", json: { recommendation: "first assessor" } }]]);
  const test = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    await setLiveModel(test.engine);
    const submit = await submitLive(
      test.engine,
      "parallel-budget-limit",
      {
        version: 1,
        maxStages: 3,
        onMissingContribution: "proceed_disclosed",
        stages: [
          { ...spec().stages[0]!, participants: ["a"] },
          {
            id: "followup",
            kind: "critique",
            participants: ["b"],
            inputs: ["stage:assess"],
            outputSchema: { type: "object" },
            quorum: 1,
          },
          {
            ...spec().stages[1]!,
            inputs: ["stage:followup"],
            participants: ["a"],
          },
        ],
      },
      [participant, { ...participant, participantId: "b", roleLabel: "x".repeat(100_000) }],
      500,
    );
    const runId = field(submit, "runId");
    if (typeof runId !== "string") throw Error("TMR submit did not return a run id");
    const run = await waitForRun(test.engine, runId, "limit_reached");
    expect(field(run, "status")).toBe("limit_reached");
    expect(field(run, "outcome")).toBe("limit_reached");
    expect(provider.calls).toHaveLength(1);
    const report = await test.engine.query(ctx, { name: "tmr.Report", args: { runId } });
    expect(field(report, "outcome")).toBe("limit_reached");
    expect(field(field(report, "coverage"), "actual")).toBe(1);
  } finally {
    await test.close();
  }
});

const failureCases: Array<{ name: string; policy: ProcessSpec["onMissingContribution"]; expectedCalls: number }> = [
  { name: "fail", policy: "fail", expectedCalls: 1 },
  { name: "quorum failure", policy: "proceed_disclosed", expectedCalls: 1 },
  { name: "retry then fail", policy: { retry: 1, then: "fail" }, expectedCalls: 2 },
];
it.each(failureCases)("reports a failed stage honestly for $name", async ({ policy, expectedCalls }) => {
  const provider = new ScriptedProvider(),
    error = { type: "error" as const, code: "provider_error" as const, message: "failed", retryable: false };
  provider.enqueueDefaultSequence(Array.from({ length: expectedCalls }, () => [error]));
  const test = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    await setLiveModel(test.engine);
    const processSpec: ProcessSpec = { ...spec(), onMissingContribution: policy },
      submit = await submitLive(test.engine, "failure-" + expectedCalls, processSpec, [participant]);
    const runId = field(submit, "runId");
    if (typeof runId !== "string") throw Error("TMR submit did not return a run id");
    const run = await waitForRun(test.engine, runId, "failed");
    expect(field(run, "outcome")).toBe("failed");
    expect(provider.calls).toHaveLength(expectedCalls);
    const report = await test.engine.query(ctx, { name: "tmr.Report", args: { runId } });
    expect(report).toMatchObject({ outcome: "failed", recommendation: null, findings: [] });
    expect(field(report, "coverage")).toMatchObject({ actual: 0, missing: 2 });
  } finally {
    await test.close();
  }
});

it("marks reduced participation partial when the missing contribution policy proceeds", async () => {
  const provider = new ScriptedProvider();
  provider.enqueueDefaultSequence([
    [{ type: "error", code: "provider_error", message: "failed", retryable: false }],
    [{ type: "output", json: { recommendation: "assessment" } }],
    [{ type: "output", json: { recommendation: "synthesis" } }],
  ]);
  const test = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    await setLiveModel(test.engine);
    const partialSpec: ProcessSpec = {
        ...spec(),
        stages: [spec().stages[0]!, { ...spec().stages[1]!, participants: ["a"] }],
      },
      submitted = await submitLive(test.engine, "partial-participation", partialSpec, [
        participant,
        { ...participant, participantId: "b" },
      ]),
      runId = field(submitted, "runId");
    if (typeof runId !== "string") throw Error("TMR submit did not return a run id");
    const run = await waitForRun(test.engine, runId, "partial");
    expect(field(run, "outcome")).toBe("partial");
    const report = await test.engine.query(ctx, { name: "tmr.Report", args: { runId } });
    expect(field(report, "coverage")).toMatchObject({ expected: 3, actual: 2, missing: 1 });
    expect(provider.calls).toHaveLength(3);
  } finally {
    await test.close();
  }
});

it("reserves worst-case call usage and keeps total settled spend within the run limit", async () => {
  let calls = 0;
  const provider: ModelProvider = {
      async *call(_model, request) {
        calls++;
        yield {
          type: "usage",
          inputTokens: estimateInputTokens(request),
          outputTokens: request.maxOutputTokens,
          quality: "reported",
        };
        yield { type: "output", json: { recommendation: "bounded" } };
        yield { type: "done", finishReason: "stop" };
      },
    },
    test = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    await setLiveModel(test.engine);
    const submit = await submitLive(test.engine, "worst-case-budget", spec(), [
      participant,
      { ...participant, participantId: "b" },
    ]);
    const runId = field(submit, "runId");
    if (typeof runId !== "string") throw Error("TMR submit did not return a run id");
    await waitForRun(test.engine, runId, "completed");
    expect(calls).toBe(4);
    const budgets = await test.engine.query(ctx, { name: "sys.Budgets", args: {} }),
      runAccount = Array.isArray(budgets)
        ? budgets.find((account) => {
            const scope = field(account, "account");
            return field(scope, "kind") === "run" && field(scope, "key") === runId;
          })
        : undefined;
    expect(runAccount).toBeDefined();
    expect(field(runAccount, "usedMicros")).toBeLessThanOrEqual(100000);
  } finally {
    await test.close();
  }
});

it("reports interrupted coverage and resumes only the missing contribution", async () => {
  let callCount = 0,
    markSecondStarted!: () => void,
    releaseSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => (markSecondStarted = resolve)),
    gate = new Promise<void>((resolve) => (releaseSecond = resolve)),
    firstProvider: ModelProvider = {
      async *call(_model, request) {
        callCount++;
        if (callCount === 2) {
          markSecondStarted();
          await gate;
        }
        yield {
          type: "output",
          json: { recommendation: request.messages[0]?.content.includes("Synthesize") ? "resume" : "assess" },
        };
        yield { type: "done", finishReason: "stop" };
      },
    },
    test = await fixture({ modelProviders: { "openai-compatible": firstProvider } });
  let reopened: ReturnType<typeof createEngine> | undefined;
  try {
    await setLiveModel(test.engine);
    const submitted = await submitLive(test.engine, "resume-interrupted", spec(), [participant]),
      runId = field(submitted, "runId");
    if (typeof runId !== "string") throw Error("TMR submit did not return a run id");
    await secondStarted;
    await test.engine.drain(0);
    await test.engine.stop();
    releaseSecond();

    let resumedCalls = 0;
    const resumeProvider: ModelProvider = {
      async *call() {
        resumedCalls++;
        yield { type: "output", json: { recommendation: "resumed synthesis" } };
        yield { type: "done", finishReason: "stop" };
      },
    };
    let restartSequence = 0;
    reopened = createEngine({
      clock,
      ids: { next: (prefix) => prefix + "reopen" + String(++restartSequence).padStart(20, "0") },
      seed: 42,
      modelProviders: { "openai-compatible": resumeProvider },
    });
    await reopened.start(test.dir);
    const auth = reopened.trustedHostAuth("admin"),
      metadata = { contractVersion: "1.0", requestId: "tmr-resume" },
      interrupted = await reopened.query(auth, metadata, { name: "tmr.Run", args: { runId } });
    expect(interrupted).toMatchObject({ status: "interrupted", outcome: "interrupted" });
    expect(field(field(interrupted, "coverage"), "actual")).toBe(1);
    const interruptedReport = await reopened.query(auth, metadata, { name: "tmr.Report", args: { runId } });
    expect(interruptedReport).toMatchObject({ outcome: "interrupted" });
    expect(field(interruptedReport, "coverage")).toMatchObject({ expected: 2, actual: 1, missing: 1 });
    const resumed = await reopened.command(auth, metadata, {
      commandId: "resume-after-interruption",
      type: "tmr.Resume",
      payload: { runId },
    });
    if (!resumed.ok) throw Error("TMR resume failed: " + JSON.stringify(resumed.error));
    let completed: Json = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      completed = await reopened.query(auth, metadata, { name: "tmr.Run", args: { runId } });
      if (field(completed, "status") === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(field(completed, "outcome")).toBe("completed");
    expect(resumedCalls).toBe(1);
    const report = await reopened.query(auth, metadata, { name: "tmr.Report", args: { runId } });
    expect(field(report, "recommendation")).toBe("resumed synthesis");
  } finally {
    await reopened?.stop();
    await test.close();
  }
});

it("keeps terminal run states final when a peer contribution completes later", async () => {
  let markStarted!: () => void,
    providerStarted = false,
    release!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve)),
    provider: ModelProvider = {
      async *call() {
        providerStarted = true;
        markStarted();
        await gate;
        yield { type: "output", json: { recommendation: "late success" } };
        yield { type: "done", finishReason: "stop" };
      },
    };
  const test = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    await test.engine.command(ctx, {
      commandId: "tmr-terminal-settings",
      type: "sys.SetSettings",
      payload: new Contract().read<Json>("json", { patch: { models: { default: liveModel } } }),
    });
    const submit = await test.engine.command(ctx, {
      commandId: "tmr-terminal-submit",
      type: "tmr.Submit",
      payload: new Contract().read<Json>("json", {
        requestId: "terminal-request",
        question: "Race",
        items: [{ itemId: "i1", kind: "text", content: "x", source: "local" }],
        criteria: [],
        processSpec: spec(),
        participants: [{ ...participant, modelRef: "default" }],
        limits: { spendMicros: 100000 },
        mode: "live",
      }),
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const runId = field(submit.result, "runId");
    if (typeof runId !== "string") throw Error("TMR submit did not return a run id");
    await Promise.race([started, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
    if (!providerStarted)
      throw Error(
        "TMR provider was not invoked: " +
          JSON.stringify(await test.engine.query(ctx, { name: "tmr.Run", args: { runId } })),
      );
    await test.engine.command(ctx, {
      commandId: "tmr-terminal-cancel",
      type: "tmr.Cancel",
      payload: new Contract().read<Json>("json", { runId }),
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const run = await test.engine.query(ctx, { name: "tmr.Run", args: { runId } });
    expect(field(run, "status")).toBe("cancelled");
    const report = await test.engine.query(ctx, { name: "tmr.Report", args: { runId } });
    expect(report).toMatchObject({ recommendation: null, findings: [] });
    expect(field(report, "missingInformation")).toEqual(
      expect.arrayContaining([expect.stringContaining("No synthesis contribution")]),
    );
    expect(field(report, "coverage")).toMatchObject({ expected: 2, actual: 0, missing: 2 });
  } finally {
    await test.close();
  }
});

it("exports a readable deterministic Markdown report and purges all artifact versions by source prefix", async () => {
  const test = await fixture();
  try {
    const submit = await test.engine.command(ctx, {
      commandId: "tmr-export-submit",
      type: "tmr.Submit",
      payload: new Contract().read<Json>("json", {
        requestId: "export-request",
        question: "Should it ship?",
        items: [{ itemId: "i1", kind: "text", content: "evidence", source: "vc:artifact/a1@3#e1" }],
        criteria: ["safety"],
        processSpec: spec(),
        participants: [participant],
        limits: { spendMicros: 1000 },
        mode: "demo",
      }),
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const runId = field(submit.result, "runId");
    if (typeof runId !== "string") throw Error("TMR submit did not return a run id");
    await waitForRun(test.engine, runId, "completed");
    const md1 = await test.engine.query(ctx, { name: "tmr.Export", args: { runId, format: "markdown" } });
    const md2 = await test.engine.query(ctx, { name: "tmr.Export", args: { runId, format: "markdown" } });
    const json = await test.engine.query(ctx, { name: "tmr.Export", args: { runId, format: "json" } });
    const content = field(md1, "content");
    expect(typeof content).toBe("string");
    expect(content).toContain("## Recommendation");
    expect(content).toContain("## Coverage");
    expect(md2).toEqual(md1);
    expect(field(json, "content")).toEqual(await test.engine.query(ctx, { name: "tmr.Report", args: { runId } }));
    const purge = await test.engine.command(ctx, {
      commandId: "tmr-export-purge",
      type: "tmr.PurgeBySource",
      payload: new Contract().read<Json>("json", { source: "vc:artifact/a1" }),
    });
    expect(purge).toMatchObject({ ok: true, result: { purged: 1 } });
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

function keys(value: unknown): string[] {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

async function setLiveModel(engine: Awaited<ReturnType<typeof fixture>>["engine"]): Promise<void> {
  await engine.command(ctx, {
    commandId: "tmr-test-live-model",
    type: "sys.SetSettings",
    payload: new Contract().read<Json>("json", { patch: { models: { default: liveModel } } }),
  });
}

async function submitLive(
  engine: Awaited<ReturnType<typeof fixture>>["engine"],
  requestId: string,
  processSpec: ProcessSpec,
  participants: (typeof participant)[],
  spendMicros = 100000,
): Promise<Json> {
  const result = await engine.command(ctx, {
    commandId: "submit-" + requestId,
    type: "tmr.Submit",
    payload: new Contract().read<Json>("json", {
      requestId,
      question: "Exercise TMR outcomes",
      items: [{ itemId: "source-1", kind: "text", content: "material", source: "local" }],
      criteria: [],
      processSpec,
      participants: participants.map((item) => ({ ...item, modelRef: "default" })),
      limits: { spendMicros },
      mode: "live",
    }),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error("TMR submit failed: " + result.error.code);
  return result.result;
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
