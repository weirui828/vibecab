import { expect, it } from "vitest";
import { Contract, type Json, type Settings } from "../../contract/src/index.js";
import { ScriptedProvider } from "../src/gateway/fake.js";
import type { ProviderModel } from "../src/gateway/types.js";
import { baseModelRef } from "../src/session-preferences.js";
import { ctx, fixture } from "./helpers.js";

// W13: agents are a pool (each a named model entry, its alias its id), and roles assign them: one agent to VibeCab,
// a panel to TMR. Calls and budgets belong to the pool agent that made them.

const model = (name: string, instructions?: string): ProviderModel => ({
  provider: "openai-compatible",
  baseUrl: "https://example.invalid/v1",
  model: "fake-" + name,
  keyRef: "test-only",
  name,
  ...(instructions ? { instructions } : {}),
  capabilities: { tools: true, jsonSchemaOutput: true, streaming: true, maxContextTokens: 8192, reportsUsage: false },
  pricing: { inputMicrosPerMillion: 100_000, outputMicrosPerMillion: 100_000 },
});
const json = (value: unknown) => new Contract().read<Json>("json", value);

it("picks a session's agent: its own choice, else the VibeCab role, else the default model, else any agent", () => {
  const settings = (models: string[], roles?: Settings["roles"], agent?: string) =>
    ({
      models: Object.fromEntries(models.map((m) => [m, {}])),
      budgets: {},
      sessions: agent ? { s1: { agent } } : {},
      ...(roles ? { roles } : {}),
    }) as unknown as Settings;
  expect(baseModelRef(settings(["ada", "bo"], { vibecab: "bo" }, "ada"), "s1")).toBe("ada");
  expect(baseModelRef(settings(["ada", "bo", "default"], { vibecab: "bo" }), "s1")).toBe("bo");
  // "vibecab" as a session's choice means the VibeCab role's agent.
  expect(baseModelRef(settings(["ada", "bo"], { vibecab: "bo" }, "vibecab"), "s1")).toBe("bo");
  // A role or choice naming an agent that left the pool falls through.
  expect(baseModelRef(settings(["default", "bo"], { vibecab: "gone" }, "gone"), "s1")).toBe("default");
  expect(baseModelRef(settings(["zed", "bo"]))).toBe("bo");
});

it("removes any agent from the pool, and from the roles it had", async () => {
  const f = await fixture();
  try {
    const set = (patch: unknown, id: string) =>
      f.engine.command(ctx, { commandId: id, type: "sys.SetSettings", payload: json({ patch }) });
    expect(
      (
        await set(
          {
            models: { default: model("Ada"), bo: model("Bo") },
            roles: { vibecab: "default", tmr: { panel: [{ agentId: "default" }, { agentId: "bo" }], spendMicros: 5 } },
          },
          "on",
        )
      ).ok,
    ).toBe(true);
    expect((await set({ models: { default: null } }, "off")).ok).toBe(true);
    const after = (await f.engine.query(ctx, { name: "sys.Settings", args: {} })) as unknown as Settings;
    expect(after.models.default).toBeUndefined();
    expect(after.roles).toEqual({ tmr: { panel: [{ agentId: "bo" }], spendMicros: 5 } });
    // Today's spending lists every agent in the pool.
    const today = (await f.engine.query(ctx, { name: "sys.SpendingToday", args: {} })) as {
      agents: Array<{ agentId: string }>;
    };
    expect(today.agents.map((a) => a.agentId)).toEqual(["bo"]);
  } finally {
    await f.close();
  }
});

it("runs TMR from the role's panel, with each agent's instructions, and records calls by agent", async () => {
  const provider = new ScriptedProvider();
  provider.enqueueDefaultSequence([
    [{ type: "output", json: { recommendation: "one" } }],
    [{ type: "output", json: { recommendation: "two" } }],
    [{ type: "output", json: { recommendation: "synthesis", findings: [] } }],
  ]);
  const f = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    const command = async (type: string, payload: unknown) => {
      const r = await f.engine.command(ctx, { commandId: type, type, payload: json(payload) });
      if (!r.ok) throw Error(`${type}: ${r.error.message}`);
      return r.result;
    };
    await command("sys.SetSettings", {
      patch: {
        models: { ada: model("Ada", "Be the skeptic."), bo: model("Bo") },
        roles: { tmr: { panel: [{ agentId: "ada", label: "Skeptic" }, { agentId: "bo" }], spendMicros: 100_000 } },
      },
    });
    const { runId } = (await command("tmr.Submit", {
      requestId: "from-role",
      question: "Is this right?",
      items: [{ itemId: "i1", kind: "text", content: "material", source: "local" }],
      criteria: [],
      mode: "live",
    })) as { runId: string };
    let run: { status?: string; participants?: Array<{ roleLabel: string; modelRef: string }> } = {};
    for (let i = 0; i < 100 && run.status !== "completed"; i++) {
      run = (await f.engine.query(ctx, { name: "tmr.Run", args: { runId } })) as typeof run;
      if (run.status !== "completed") await new Promise((r) => setTimeout(r, 20));
    }
    expect(run.status).toBe("completed");
    expect(run.participants?.map((p) => [p.roleLabel, p.modelRef])).toEqual([
      ["Skeptic", "ada"],
      ["Bo", "bo"],
    ]);
    const byModel = (alias: string) => provider.calls.filter((c) => c.request.modelRef === alias);
    for (const call of byModel("ada"))
      expect(call.request.messages.map((m) => m.content)).toContainEqual(expect.stringContaining("Be the skeptic."));
    for (const call of byModel("bo"))
      expect(call.request.messages.map((m) => m.content).join("\n")).not.toContain("Be the skeptic.");
    const { calls } = (await f.engine.query(ctx, { name: "sys.Usage", args: {} })) as {
      calls: Array<{ agentId?: string }>;
    };
    expect(new Set(calls.map((c) => c.agentId))).toEqual(new Set(["ada", "bo"]));
  } finally {
    await f.close();
  }
});

it("refuses a TMR run with no panel or no spending cap", async () => {
  const f = await fixture();
  try {
    const submit = (id: string) =>
      f.engine.command(ctx, {
        commandId: id,
        type: "tmr.Submit",
        payload: json({ requestId: id, question: "Q", items: [], criteria: [], mode: "demo" }),
      });
    expect(await submit("no-panel")).toMatchObject({ ok: false, error: { code: "invalid" } });
    await f.engine.command(ctx, {
      commandId: "panel",
      type: "sys.SetSettings",
      payload: json({ patch: { models: { ada: model("Ada") }, roles: { tmr: { panel: [{ agentId: "ada" }] } } } }),
    });
    expect(await submit("no-cap")).toMatchObject({ ok: false, error: { code: "invalid" } });
  } finally {
    await f.close();
  }
});
