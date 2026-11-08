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

it("sets the daily limit and agent limits from Settings", async () => {
  await open("/settings");
  const spending = tl.within(await tl.screen.findByRole("region", { name: "Spending" }));
  tl.fireEvent.change(spending.getByLabelText("Daily limit in dollars"), { target: { value: "7.5" } });
  tl.fireEvent.click(spending.getByRole("button", { name: "Save" }));
  await tl.waitFor(async () => {
    const usage = await bridge.query<{ accounts: Array<{ account: { kind: string }; limitMicros: number }> }>(
      "sys.Usage",
      {},
    );
    expect(usage.accounts.find((a) => a.account.kind === "daily")?.limitMicros).toBe(7_500_000);
  });
  const agent = tl.within(tl.screen.getByRole("region", { name: "The agent" }));
  tl.fireEvent.change(agent.getByLabelText("Wait before replying (seconds)"), { target: { value: "4" } });
  tl.fireEvent.click(agent.getByRole("button", { name: "Save" }));
  await tl.waitFor(async () => {
    const settings = await bridge.query<{ budgets?: { realtimeDebounceSeconds?: number } }>("sys.Settings", {});
    expect(settings.budgets?.realtimeDebounceSeconds).toBe(4);
  });
});

it("gives the assistant access once, lists it without the secret, and revokes it", async () => {
  const { container } = await open("/settings");
  const assistant = tl.within(await tl.screen.findByRole("region", { name: "Your AI assistant" }));
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

it("makes a sign-in link for another browser", async () => {
  await open("/settings");
  tl.fireEvent.click(await tl.screen.findByRole("button", { name: "Make a sign-in link" }));
  await tl.waitFor(() => expect(document.querySelector("#browser pre")?.textContent).toMatch(/\?launch=/));
});
