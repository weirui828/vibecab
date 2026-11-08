import { expect, it } from "vitest";
import { Contract } from "../../contract/src/index.js";
import type { Json } from "../../contract/src/index.js";
import { SdkAgentProvider, sdkModel } from "../src/gateway/providers/sdk-agent.js";
import type { SdkRun, SdkRunner } from "../src/gateway/providers/sdk-agent.js";
import type { ModelEvent, ModelRequest, ProviderModel } from "../src/gateway/types.js";
import { ctx, fixture } from "./helpers.js";

// W12: Claude Code and Codex reply in threads through their SDKs. The engine still runs every tool itself, as the
// agent, validated; the SDK only says what it wants. Tests never start a real SDK: the runner is a fake.

const collect = async (events: AsyncIterable<ModelEvent>) => {
  const out: ModelEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  modelRef: "claude-code",
  messages: [
    { role: "system", content: "You are VibeCab's agent." },
    { role: "user", content: "Tighten the first sentence." },
  ],
  maxOutputTokens: 512,
  ...over,
});
const tools: ModelRequest["tools"] = [
  {
    name: "reply",
    description: "Reply in a thread.",
    parameters: { type: "object", properties: { body: { type: "string" } } },
  },
];
const fake =
  (answer: unknown, seen: SdkRun[] = []): SdkRunner =>
  async (run) => {
    seen.push(run);
    return { json: answer, usage: { inputTokens: 300, outputTokens: 40, cachedInputTokens: 200 } };
  };
const opts = () => ({ reservationId: "r1", signal: new AbortController().signal });

it("turns an SDK agent's answer into text, validated tool calls and reported usage", async () => {
  const seen: SdkRun[] = [];
  const provider = new SdkAgentProvider(
    fake(
      { text: "On it.", toolCalls: [{ name: "reply", argumentsJson: '{"body":"Shorter."}' }], outputJson: "" },
      seen,
    ),
  );
  const events = await collect(provider.call(sdkModel("claude-agent-sdk"), request({ tools }), opts()));
  expect(events).toEqual([
    { type: "text_delta", text: "On it." },
    { type: "tool_call", call: { id: "r1:0", name: "reply", arguments: { body: "Shorter." } } },
    { type: "usage", inputTokens: 300, outputTokens: 40, cachedInputTokens: 200, quality: "reported" },
    { type: "done", finishReason: "tool_calls" },
  ]);
  // The SDK hears the whole conversation and the tools, and answers in one strict shape (Codex needs strict schemas).
  expect(seen[0]!.prompt).toContain("Tighten the first sentence.");
  expect(seen[0]!.prompt).toContain('"reply"');
  expect(seen[0]!.schema).toMatchObject({ required: ["text", "toolCalls", "outputJson"], additionalProperties: false });
});

it("returns structured output as the engine asked, and refuses what does not fit", async () => {
  const json = await collect(
    new SdkAgentProvider(fake({ text: "", toolCalls: [], outputJson: '{"title":"Better"}' })).call(
      sdkModel("codex-sdk"),
      request({ output: { kind: "json", name: "x", schema: { type: "object" } } }),
      opts(),
    ),
  );
  expect(json).toContainEqual({ type: "output", json: { title: "Better" } });
  expect(json.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  // A tool it was not offered, broken JSON, or an answer in the wrong shape is a provider error, never a tool call.
  for (const answer of [
    { text: "", toolCalls: [{ name: "create_grant", argumentsJson: "{}" }], outputJson: "" },
    { text: "", toolCalls: [{ name: "reply", argumentsJson: "{not json" }], outputJson: "" },
    "just words",
  ]) {
    const events = await collect(
      new SdkAgentProvider(fake(answer)).call(sdkModel("claude-agent-sdk"), request({ tools }), opts()),
    );
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "provider_error" }));
  }
});

it("reports a failed or cancelled run as an error", async () => {
  const failing = new SdkAgentProvider(async () => {
    throw new Error("Not signed in");
  });
  expect(await collect(failing.call(sdkModel("claude-agent-sdk"), request(), opts()))).toContainEqual(
    expect.objectContaining({ type: "error", code: "provider_error" }),
  );
  const abort = new AbortController();
  abort.abort();
  expect(
    await collect(
      new SdkAgentProvider(fake({})).call(sdkModel("codex-sdk"), request(), {
        reservationId: "r",
        signal: abort.signal,
      }),
    ),
  ).toContainEqual(expect.objectContaining({ type: "error", code: "cancelled" }));
});

it("lets Claude Code reply in a session: as the agent, at no cost, recorded as its own", async () => {
  let threadId = "";
  const seen: SdkRun[] = [];
  const runner: SdkRunner = async (run) => {
    seen.push(run);
    return seen.length === 1
      ? {
          json: {
            text: "",
            toolCalls: [
              {
                name: "reply",
                argumentsJson: JSON.stringify({ threadId, body: "Claude Code here: cut the second clause." }),
              },
            ],
            outputJson: "",
          },
          usage: { inputTokens: 500, outputTokens: 60 },
        }
      : { json: { text: "Replied.", toolCalls: [], outputJson: "" }, usage: { inputTokens: 520, outputTokens: 5 } };
  };
  const f = await fixture({ modelProviders: { "claude-agent-sdk": new SdkAgentProvider(runner) } });
  try {
    const cmd = async <T>(type: string, payload: unknown, id = type) => {
      const r = await f.engine.command(ctx, {
        commandId: id,
        type,
        payload: new Contract().read<Json>("json", payload),
      });
      if (!r.ok) throw Error(`${type}: ${r.error.message}`);
      return r.result as T;
    };
    const session = await cmd<{ sessionId: string }>("vc.StartSession", { title: "Review", replyTrigger: "manual" });
    await cmd("sys.SetSettings", {
      patch: {
        models: { "claude-code": sdkModel("claude-agent-sdk") as unknown as Json },
        budgets: { toolCallLimit: 8 },
        sessions: { [session.sessionId]: { agent: "claude-code" } },
      },
    });
    const posted = await cmd<{ threadId: string }>("vc.Comment", { sessionId: session.sessionId, body: "Too long?" });
    threadId = posted.threadId;
    await cmd("vc.AskAgent", { sessionId: session.sessionId, threadIds: [threadId] });
    let threads: Array<{ comments: Array<{ author: { kind: string }; body: string }> }> = [];
    for (let i = 0; i < 100; i++) {
      threads = (await f.engine.query(ctx, {
        name: "vc.Threads",
        args: { sessionId: session.sessionId },
      })) as typeof threads;
      if (threads[0]?.comments.some((c) => c.author.kind === "agent")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // It replied through the engine's own tool, as the agent — never as the person.
    expect(threads[0]!.comments.find((c) => c.author.kind === "agent")?.body).toBe(
      "Claude Code here: cut the second clause.",
    );
    // Paid by its own subscription: nothing charged, and its calls are its own.
    const usage = (await f.engine.query(ctx, { name: "sys.Usage", args: {} })) as {
      calls: Array<{ agentId?: string; settledMicros?: number; purpose?: string }>;
    };
    expect(usage.calls.length).toBeGreaterThan(0);
    for (const call of usage.calls)
      expect(call).toMatchObject({ agentId: "claude-code", settledMicros: 0, purpose: "reply" });
    expect(seen[0]!.model).toBeUndefined();
  } finally {
    await f.close();
  }
});

it("describes an SDK model the engine can store: no key, priced at zero", () => {
  const model: ProviderModel = sdkModel("codex-sdk", "gpt-6.1-sol");
  expect(new Contract().read("provider-model", model)).toMatchObject({
    provider: "codex-sdk",
    model: "gpt-6.1-sol",
    pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
  });
  expect(model.keyRef).toBeUndefined();
});

it("turns an SDK agent off by removing its model, but never the default model", async () => {
  const f = await fixture();
  try {
    const set = (models: Record<string, unknown>, id: string) =>
      f.engine.command(ctx, {
        commandId: id,
        type: "sys.SetSettings",
        payload: new Contract().read<Json>("json", { patch: { models } }),
      });
    expect((await set({ codex: sdkModel("codex-sdk") }, "on")).ok).toBe(true);
    expect(await f.engine.query(ctx, { name: "sys.Settings", args: {} })).toMatchObject({
      models: { codex: { provider: "codex-sdk" } },
    });
    expect((await set({ codex: null }, "off")).ok).toBe(true);
    const after = (await f.engine.query(ctx, { name: "sys.Settings", args: {} })) as {
      models: Record<string, unknown>;
    };
    expect(after.models.codex).toBeUndefined();
    expect(await set({ default: null }, "no-default")).toMatchObject({ ok: false, error: { code: "invalid" } });
  } finally {
    await f.close();
  }
});

it("needs no default model: with Claude Code alone, it replies in a session that chose no agent", async () => {
  let threadId = "";
  const runner: SdkRunner = async (run) =>
    run.prompt.includes("Result of tool call")
      ? { json: { text: "Done.", toolCalls: [], outputJson: "" } }
      : {
          json: {
            text: "",
            toolCalls: [{ name: "reply", argumentsJson: JSON.stringify({ threadId, body: "Only Claude Code here." }) }],
            outputJson: "",
          },
        };
  const f = await fixture({ modelProviders: { "claude-agent-sdk": new SdkAgentProvider(runner) } });
  try {
    const cmd = async <T>(type: string, payload: unknown) => {
      const r = await f.engine.command(ctx, {
        commandId: type,
        type,
        payload: new Contract().read<Json>("json", payload),
      });
      if (!r.ok) throw Error(`${type}: ${r.error.message}`);
      return r.result as T;
    };
    await cmd("sys.SetSettings", {
      patch: { models: { "claude-code": sdkModel("claude-agent-sdk") as unknown as Json } },
    });
    const { sessionId } = await cmd<{ sessionId: string }>("vc.StartSession", {
      title: "Solo",
      replyTrigger: "manual",
    });
    threadId = (await cmd<{ threadId: string }>("vc.Comment", { sessionId, body: "Anyone?" })).threadId;
    await cmd("vc.AskAgent", { sessionId, threadIds: [threadId] });
    let body: string | undefined;
    for (let i = 0; i < 100 && !body; i++) {
      const threads = (await f.engine.query(ctx, { name: "vc.Threads", args: { sessionId } })) as Array<{
        comments: Array<{ author: { kind: string }; body: string }>;
      }>;
      body = threads[0]?.comments.find((c) => c.author.kind === "agent")?.body;
      if (!body) await new Promise((r) => setTimeout(r, 20));
    }
    expect(body).toBe("Only Claude Code here.");
  } finally {
    await f.close();
  }
});

it("picks the model for a session's work: the default, else its chosen agent, else any agent that is on", async () => {
  const { baseModelRef } = await import("../src/session-preferences.js");
  const settings = (models: string[], agent?: string) =>
    ({
      models: Object.fromEntries(models.map((m) => [m, {}])),
      budgets: {},
      sessions: agent ? { s1: { agent } } : {},
    }) as unknown as import("../../contract/src/index.js").Settings;
  expect(baseModelRef(settings(["default", "codex"]), "s1")).toBe("default");
  expect(baseModelRef(settings(["claude-code", "codex"], "codex"), "s1")).toBe("codex");
  expect(baseModelRef(settings(["codex"]), "s1")).toBe("codex");
  expect(baseModelRef(settings(["claude-code", "codex"]))).toBe("claude-code");
  expect(baseModelRef(settings([]))).toBe("default");
});
