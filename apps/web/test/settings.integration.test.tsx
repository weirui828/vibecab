import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, it } from "vitest";
import { webBridge } from "../src/bridge/webBridge.js";
import type { WebBridge } from "../src/bridge/webBridge.js";
import { startTestHost } from "./helpers.js";
import type { TestHost } from "./helpers.js";

let t: TestHost, dom: JSDOM, bridge: WebBridge;
let tl: typeof import("@testing-library/react");
const globals = ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "Event"] as const;
const SECRET = "sk-test-not-a-real-key-0123456789";

beforeAll(async () => {
  t = await startTestHost();
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  for (const key of globals) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  tl = await import("@testing-library/react");
  bridge = webBridge({ base: t.host.url, fetch: t.fetch, retryMs: 50 });
}, 60_000);
afterAll(async () => {
  tl?.cleanup();
  await t?.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  dom?.window.close();
  for (const key of globals) Reflect.deleteProperty(globalThis, key);
});

async function open(path: string) {
  tl.cleanup();
  window.location.hash = path;
  const { App } = await import("../src/App.js");
  return tl.render(<App bridge={bridge} />);
}
const click = (name: string | RegExp) => tl.fireEvent.click(tl.screen.getByRole("button", { name }));

it("walks a new workspace through the first run, skipping what it does not need", async () => {
  const { container } = await open("/");
  await tl.screen.findByText("Welcome to VibeCab.");
  click("Get started");
  await tl.screen.findByRole("heading", { name: "Choose a model" });
  click("Skip for now");
  await tl.screen.findByRole("heading", { name: "A daily limit" });
  tl.fireEvent.change(tl.screen.getByLabelText("Dollars per day"), { target: { value: "3" } });
  click("Continue");
  await tl.screen.findByRole("heading", { name: "Your first draft" });
  const [daily] = await bridge.query<Array<{ account: { kind: string }; limitMicros: number }>>("sys.Budgets", {});
  expect(daily).toMatchObject({ account: { kind: "daily" }, limitMicros: 3_000_000 });
  click("Later");
  await tl.waitFor(() => expect(container.textContent).toContain("Nothing drafted yet."));
  expect(localStorage.getItem("vc-first-run-done")).toBe("1");
});

it("saves the model and key; the key never comes back to the page", async () => {
  const { container } = await open("/settings");
  const model = await tl.screen.findByRole("region", { name: "Model" });
  const form = tl.within(model);
  tl.fireEvent.change(form.getByLabelText("Model"), { target: { value: "gpt-test" } });
  tl.fireEvent.change(form.getByLabelText("API key"), { target: { value: SECRET } });
  tl.fireEvent.click(form.getByRole("button", { name: "Save" }));
  await tl.waitFor(async () => {
    const settings = await bridge.query<{ models?: { default?: { model: string; keyRef?: string } } }>(
      "sys.Settings",
      {},
    );
    expect(settings.models?.default).toMatchObject({ model: "gpt-test", keyRef: expect.any(String) });
  });
  await tl.waitFor(() => expect(form.getByText(/Key saved/)).toBeTruthy());
  expect((form.getByLabelText("API key") as HTMLInputElement).value).toBe("");
  expect(container.innerHTML).not.toContain(SECRET);
  expect(JSON.stringify(await bridge.query("sys.Settings", {}))).not.toContain(SECRET);
});

it("picks a built-in provider and model: address, context and price come from the catalog", async () => {
  type Saved = {
    baseUrl: string;
    model: string;
    keyRef?: string;
    catalogProvider?: string;
    pricingSource?: string;
    pricing: { inputMicrosPerMillion: number; outputMicrosPerMillion: number };
    capabilities: { maxContextTokens: number };
  };
  const saved = async () => (await bridge.query<{ models?: { default?: Saved } }>("sys.Settings", {})).models?.default;
  await open("/settings/agents");
  const model = tl.within(await tl.screen.findByRole("region", { name: "Model" }));
  const save = () => tl.fireEvent.click(model.getByRole("button", { name: "Save" }));
  tl.fireEvent.change(model.getByLabelText("Provider"), { target: { value: "groq" } });
  tl.fireEvent.change(model.getByLabelText("Model"), { target: { value: "openai/gpt-oss-120b" } });
  expect(model.getByText(/\$0\.15 in · \$0\.60 out per million tokens · 131K context/)).toBeTruthy();
  // Another provider's saved key is not this one's.
  save();
  expect((await model.findByRole("alert")).textContent).toBe("Paste the API key for this provider.");
  tl.fireEvent.change(model.getByLabelText("API key"), { target: { value: "groq-test-key" } });
  save();
  await tl.waitFor(async () =>
    expect(await saved()).toMatchObject({
      baseUrl: "https://api.groq.com/openai/v1",
      model: "openai/gpt-oss-120b",
      catalogProvider: "groq",
      pricingSource: "catalog",
      pricing: { inputMicrosPerMillion: 150_000, outputMicrosPerMillion: 600_000 },
      capabilities: { maxContextTokens: 131_072 },
    }),
  );
  // Saving also stores the key; the form is free again once it says so.
  await tl.screen.findByText("Model saved");
  // A price changed by hand is kept as yours.
  tl.fireEvent.click(model.getByRole("button", { name: "More details" }));
  tl.fireEvent.change(model.getByLabelText("Input price ($ per 1 million tokens)"), { target: { value: "0.2" } });
  save();

  await tl.waitFor(async () =>
    expect(await saved()).toMatchObject({ pricingSource: "custom", pricing: { inputMicrosPerMillion: 200_000 } }),
  );
});

it("lists a local server's models and needs no key; an address with blanks is refused", async () => {
  await open("/settings/agents");
  const model = tl.within(await tl.screen.findByRole("region", { name: "Model" }));
  tl.fireEvent.change(model.getByLabelText("Provider"), { target: { value: "ollama" } });
  expect(model.queryByLabelText("API key")).toBeNull();
  await tl.waitFor(() => expect(model.getByText("1 to choose from, or type any model name.")).toBeTruthy());
  tl.fireEvent.change(model.getByLabelText("Model"), { target: { value: "llama-local:8b" } });
  tl.fireEvent.click(model.getByRole("button", { name: "Save" }));
  await tl.waitFor(async () => {
    const settings = await bridge.query<{ models?: { default?: { baseUrl: string; model: string; keyRef?: string } } }>(
      "sys.Settings",
      {},
    );
    expect(settings.models?.default).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      model: "llama-local:8b",
      keyRef: expect.any(String),
    });
  });
  tl.fireEvent.change(model.getByLabelText("Provider"), { target: { value: "cloudflare-workers-ai" } });
  tl.fireEvent.change(model.getByLabelText("Model"), { target: { value: "@cf/openai/gpt-oss-20b" } });
  tl.fireEvent.change(model.getByLabelText("API key"), { target: { value: "cf-token" } });
  tl.fireEvent.click(model.getByRole("button", { name: "Save" }));
  expect((await model.findByRole("alert")).textContent).toBe("Type the Cloudflare account ID.");
});

it("sets the daily limit and agent limits from Settings", async () => {
  await open("/settings/spending");
  const spending = tl.within(await tl.screen.findByRole("region", { name: "Spending" }));
  tl.fireEvent.change(spending.getByLabelText("Daily limit in dollars"), { target: { value: "7.5" } });
  tl.fireEvent.click(spending.getAllByRole("button", { name: "Save" })[0]!);
  await tl.waitFor(async () => {
    const usage = await bridge.query<{ accounts: Array<{ account: { kind: string }; limitMicros: number }> }>(
      "sys.Usage",
      {},
    );
    expect(usage.accounts.find((a) => a.account.kind === "daily")?.limitMicros).toBe(7_500_000);
  });
  // What one reply may cost is with the rest of the money.
  tl.fireEvent.change(spending.getByLabelText("Maximum cost of one reply ($)"), { target: { value: "0.4" } });
  tl.fireEvent.click(spending.getAllByRole("button", { name: "Save" })[1]!);
  await tl.waitFor(async () => {
    const settings = await bridge.query<{ budgets?: { defaultTurnLimitMicros?: number } }>("sys.Settings", {});
    expect(settings.budgets?.defaultTurnLimitMicros).toBe(400_000);
  });
  tl.fireEvent.click(tl.screen.getByRole("tab", { name: "Agents" }));
  const agent = tl.within(await tl.screen.findByRole("region", { name: "How it replies" }));
  tl.fireEvent.change(agent.getByLabelText("Delay before a reply (seconds)"), { target: { value: "4" } });
  tl.fireEvent.click(agent.getByRole("button", { name: "Save" }));
  await tl.waitFor(async () => {
    const settings = await bridge.query<{
      budgets?: { realtimeDebounceSeconds?: number; defaultTurnLimitMicros?: number };
    }>("sys.Settings", {});
    expect(settings.budgets?.realtimeDebounceSeconds).toBe(4);
    // Saving one part of the agent's settings keeps the others.
    expect(settings.budgets?.defaultTurnLimitMicros).toBe(400_000);
  });
});

it("gives the VibeCab agent its own daily limit beside the overall one", async () => {
  await open("/settings/spending");
  const spending = tl.within(await tl.screen.findByRole("region", { name: "Spending" }));
  const field = await spending.findByLabelText("VibeCab agent: daily limit ($)");
  tl.fireEvent.change(field, { target: { value: "1.25" } });
  tl.fireEvent.submit(field.closest("form")!);
  await tl.waitFor(async () => {
    const today = await bridge.query<{ agents: Array<{ agentId: string; limitMicros: number | null }> }>(
      "sys.SpendingToday",
      {},
    );
    expect(today.agents).toContainEqual(expect.objectContaining({ agentId: "vibecab", limitMicros: 1_250_000 }));
  });
  await tl.waitFor(() => expect(spending.getByText(/\$0\.00 today of \$1\.25/)).toBeTruthy());
});

it("gives the assistant access once, lists it without the secret, and revokes it", async () => {
  const { container } = await open("/settings/agents");
  const assistant = tl.within(await tl.screen.findByRole("region", { name: "Your AI assistants" }));
  await tl.waitFor(() =>
    expect(assistant.getByRole("button", { name: "Read only" })).not.toHaveProperty("disabled", true),
  );
  tl.fireEvent.click(assistant.getByRole("button", { name: "Read only" }));
  const config = await tl.waitFor(() => {
    const pre = container.querySelector("#assistant pre");
    if (!pre) throw new Error("no config");
    return pre.textContent ?? "";
  });
  const parsed = JSON.parse(config) as {
    mcpServers: { vibecab: { env: { VIBECAB_MCP_TOKEN: string; VIBECAB_WORKSPACE: string } } };
  };
  const token = parsed.mcpServers.vibecab.env.VIBECAB_MCP_TOKEN;
  expect(token.length).toBeGreaterThanOrEqual(32);
  expect(parsed.mcpServers.vibecab.env.VIBECAB_WORKSPACE).toBe(t.workspace);
  expect(JSON.stringify(await bridge.query("sys.AccessTokens", {}))).not.toContain(token);
  tl.fireEvent.click(assistant.getByRole("button", { name: "Done" }));
  expect(container.innerHTML).not.toContain(token);
  tl.fireEvent.click(await assistant.findByRole("button", { name: "Revoke" }));
  await tl.waitFor(async () => {
    const tokens = await bridge.query<Array<{ channel: string; revokedAt?: string }>>("sys.AccessTokens", {});
    expect(tokens.filter((x) => x.channel === "mcp").every((x) => x.revokedAt)).toBe(true);
  });
});

it("groups Settings in three tabs: each agent with its own parts, then Spending and General", async () => {
  await open("/settings");
  const agents = await tl.screen.findByRole("tab", { name: "Agents" });
  expect(agents.getAttribute("aria-selected")).toBe("true");
  const vibecab = await tl.screen.findByRole("region", { name: "VibeCab agent" });
  for (const part of ["Model", "How it replies", "What it may do", "Its tools"])
    expect(tl.within(vibecab).getByRole("region", { name: part })).toBeTruthy();
  const assistants = tl.screen.getByRole("region", { name: "Your AI assistants" });
  expect(tl.within(assistants).getByRole("region", { name: "Connect an assistant" })).toBeTruthy();
  expect(tl.screen.queryByRole("region", { name: "Spending" })).toBeNull();
  tl.fireEvent.keyDown(agents, { key: "ArrowRight" });
  await tl.waitFor(() => expect(window.location.hash).toBe("#/settings/spending"));
  expect((await tl.screen.findByRole("tab", { name: "Spending" })).getAttribute("aria-selected")).toBe("true");
  expect(await tl.screen.findByRole("region", { name: "Spending" })).toBeTruthy();
  tl.fireEvent.keyDown(tl.screen.getByRole("tab", { name: "Spending" }), { key: "End" });
  await tl.waitFor(() => expect(window.location.hash).toBe("#/settings/general"));
  for (const part of ["Your data", "Appearance", "Open on another browser", "About"])
    expect(await tl.screen.findByRole("region", { name: part })).toBeTruthy();
});

it("sends addresses from before the three tabs to where each part now lives", async () => {
  for (const [old, now, part] of [
    ["tools", "agents", "Its tools"],
    ["permissions", "agents", "What it may do"],
    ["about", "general", "About"],
  ] as const) {
    await open("/settings/" + old);
    await tl.waitFor(() => expect(window.location.hash).toBe("#/settings/" + now));
    expect(await tl.screen.findByRole("region", { name: part })).toBeTruthy();
  }
});

it("shows when the engine started in General → About, with a way to restart it", async () => {
  await open("/settings/general");
  const about = tl.within(await tl.screen.findByRole("region", { name: "About" }));
  expect(await about.findByText("Engine started")).toBeTruthy();
  expect(about.getByRole("button", { name: "Restart engine" })).toBeTruthy();
});

it("makes a sign-in link for another browser", async () => {
  await open("/settings/general");
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Make a sign-in link" }));
  await tl.waitFor(() => expect(document.querySelector("#browser pre")?.textContent).toMatch(/\?launch=/));
});

it("turns Claude Code on and off, and a session can choose who replies", async () => {
  const models = async () =>
    (await bridge.query<{ models: Record<string, { provider: string; model: string }> }>("sys.Settings", {})).models;
  await open("/settings/agents");
  const claude = tl.within(await tl.screen.findByRole("region", { name: "Claude Code" }));
  expect(claude.getByText("Off")).toBeTruthy();
  tl.fireEvent.click(claude.getByRole("button", { name: "Use Claude Code" }));
  await tl.waitFor(async () =>
    expect((await models())["claude-code"]).toMatchObject({ provider: "claude-agent-sdk", model: "default" }),
  );
  await tl.waitFor(() => expect(claude.getByText(/^On\. /)).toBeTruthy());
  // A session can now pick it in its Agent panel.
  const started = await bridge.command("vc.StartSession", { title: "Pick an agent" });
  if (!started.ok) throw Error(started.error.message);
  const { sessionId } = started.result as { sessionId: string };
  const artifact = await bridge.command("vc.CreateArtifact", { title: "Agent draft", mediaKind: "doc" });
  if (!artifact.ok) throw Error(artifact.error.message);
  await bridge.command("vc.AttachArtifact", {
    sessionId,
    artifactId: (artifact.result as { artifactId: string }).artifactId,
    role: "primary",
  });
  await open("/s/" + sessionId);
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Agent" }));
  const who = await tl.screen.findByRole("group", { name: "Who replies" });
  tl.fireEvent.click(tl.within(who).getByRole("button", { name: "Claude Code" }));
  await tl.waitFor(async () => {
    const settings = await bridge.query<{ sessions: Record<string, { agent?: string }> }>("sys.Settings", {});
    expect(settings.sessions[sessionId]?.agent).toBe("claude-code");
  });
  expect(await tl.screen.findByText("Claude Code replies")).toBeTruthy();
  // Turned off, it leaves the settings; the session falls back to the VibeCab agent.
  await open("/settings/agents");
  const again = tl.within(await tl.screen.findByRole("region", { name: "Claude Code" }));
  tl.fireEvent.click(await again.findByRole("button", { name: "Turn Claude Code off" }));
  await tl.waitFor(async () => expect((await models())["claude-code"]).toBeUndefined());
});
