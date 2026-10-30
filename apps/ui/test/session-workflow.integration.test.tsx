import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import { Contract, type Json, type Settings, type SysCreateAccessTokenOperation } from "../../../contract/src/index.js";
import { inProcess } from "../../../adapters/in-process/src/index.js";
import { httpClient, startHttp } from "../../../adapters/http/src/index.js";
import { ctx, fixture } from "../../../engine/test/helpers.js";
import { ScriptedProvider } from "../../../engine/src/gateway/fake.js";
import type { ModelEvent, ProviderModel } from "../../../engine/src/gateway/types.js";
import type { ContractBridge } from "../src/api.js";
import { App } from "../src/view/App.js";

const model: ProviderModel = {
  provider: "openai-compatible",
  baseUrl: "https://model.example.test/v1",
  model: "scripted",
  capabilities: {
    tools: true,
    jsonSchemaOutput: true,
    streaming: true,
    maxContextTokens: 8192,
    reportsUsage: true,
  },
  pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
};
let cleanup: () => void = () => undefined,
  dom: JSDOM | undefined;

afterEach(() => {
  cleanup();
  dom?.window.close();
  dom = undefined;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "navigator");
  Reflect.deleteProperty(globalThis, "CSS");
});

it("shows and resolves a conflict in the live session UI", async () => {
  const app = await mountSession({ content: "One paragraph." });
  try {
    const element = app.elements[0]!;
    await app.agree("First request", element.elementId);
    await app.agree("Second request", element.elementId);
    await app.reloadSession();
    expect(
      await app.query<Array<{ conflictId: string }>>("vc.Conflicts", {
        sessionId: app.sessionId,
        artifactId: app.artifactId,
      }),
    ).toHaveLength(1);
    expect(await app.screen.findByText("Conflicts (1)", {}, { timeout: 4_000 })).toBeTruthy();
    const keepButtons = await app.screen.findAllByRole("button", { name: "Keep this one" });
    await app.fireEvent.click(keepButtons[0]!);
    await app.waitFor(() => expect(app.screen.queryByText("Conflicts (1)")).toBeNull());
  } finally {
    await app.close();
  }
});

it("holds an Update for plan approval and applies the plan after approval", async () => {
  const app = await mountSession({ content: "Before text.", planReview: true });
  try {
    const item = await app.agree("Rewrite this paragraph", app.elements[0]!.elementId);
    await app.reloadSession();
    expect(
      await app.query<Array<{ agreementId: string; state: string }>>("vc.DecisionRecord", {
        artifactId: app.artifactId,
      }),
    ).toMatchObject([{ agreementId: item.agreementId, state: "agreed" }]);
    expect((await app.query<{ models: Record<string, unknown> }>("sys.Settings", {})).models.default).toBeDefined();
    expect(
      (await app.query<{ sessions: Record<string, { planReview?: boolean }> }>("sys.Settings", {})).sessions[
        app.sessionId
      ]?.planReview,
    ).toBe(true);
    app.provider.enqueueDefaultSequence([
      plan(item.agreementId, app.elements[0]!.elementId),
      write(item.agreementId, app.elements[0]!.elementId, "After text."),
    ]);
    await (await app.screen.findByRole("button", { name: "Update now" }, { timeout: 4_000 })).click();
    await app.waitFor(async () =>
      expect(
        (await app.query<{ updates: Array<{ status: string }> }>("vc.Updates", { artifactId: app.artifactId }))
          .updates[0]?.status,
      ).toBe("awaiting_plan_review"),
    );
    await app.screen.findByRole("button", { name: "Approve plan" }, { timeout: 4_000 });
    expect(await app.headVersion()).toBe(1);
    await app.screen.getByRole("button", { name: "Approve plan" }).click();
    await app.waitFor(async () => expect(await app.headVersion()).toBe(2), { timeout: 10_000 });
    await app.waitFor(async () => expect(await app.latestUpdateStatus()).toBe("committed"), { timeout: 10_000 });
    expect(await app.screen.findByText("Rewrite this paragraph — Applied", {}, { timeout: 4_000 })).toBeTruthy();
    expect(app.screen.getByText("1 item applied · 0 not applied")).toBeTruthy();
  } finally {
    await app.close();
  }
});

it("cancels an Update during plan review without changing the version", async () => {
  const app = await mountSession({ content: "Before text.", planReview: true });
  try {
    const item = await app.agree("Rewrite this paragraph", app.elements[0]!.elementId);
    await app.reloadSession();
    app.provider.enqueueDefaultSequence([plan(item.agreementId, app.elements[0]!.elementId)]);
    await (await app.screen.findByRole("button", { name: "Update now" }, { timeout: 4_000 })).click();
    await app.screen.findByRole("button", { name: "Approve plan" }, { timeout: 4_000 });
    app.dom.window.confirm = () => true;
    await (await app.screen.findByRole("button", { name: "Cancel" })).click();
    await app.waitFor(async () => expect(await app.latestUpdateStatus()).toBe("cancelled"));
    expect(await app.headVersion()).toBe(1);
    expect(app.screen.getByText("Agreed — waiting for the next Update")).toBeTruthy();
  } finally {
    await app.close();
  }
});

it("cancels an Update while its scripted provider call is running", async () => {
  const app = await mountSession({ content: "Before text." });
  try {
    await app.agree("Rewrite this paragraph", app.elements[0]!.elementId);
    await app.reloadSession();
    app.provider.enqueueDefaultHang();
    await (await app.screen.findByRole("button", { name: "Update now" }, { timeout: 4_000 })).click();
    await app.screen.findByText(/Update: planning|Update: writing/, {}, { timeout: 4_000 });
    app.dom.window.confirm = () => true;
    await (await app.screen.findByRole("button", { name: "Cancel Update" }, { timeout: 4_000 })).click();
    await app.waitFor(async () => expect(await app.latestUpdateStatus()).toBe("cancelled"));
    expect(await app.headVersion()).toBe(1);
  } finally {
    await app.close();
  }
});

it("shows a failed writer reason and Try again action in the UI", async () => {
  const app = await mountSession({ content: "Before text." });
  try {
    const item = await app.agree("Rewrite this paragraph", app.elements[0]!.elementId);
    await app.reloadSession();
    const invalid: ModelEvent[] = [
      { type: "output", json: {} },
      { type: "usage", inputTokens: 20, outputTokens: 10, quality: "reported" },
      { type: "done", finishReason: "stop" },
    ];
    app.provider.enqueueDefaultSequence([
      plan(item.agreementId, app.elements[0]!.elementId),
      invalid,
      invalid,
      plan(item.agreementId, app.elements[0]!.elementId),
      write(item.agreementId, app.elements[0]!.elementId, "After retry."),
    ]);
    await (await app.screen.findByRole("button", { name: "Update now" }, { timeout: 4_000 })).click();
    await app.screen.findByText(/Not applied:/, {}, { timeout: 4_000 });
    await app.screen.findByRole("button", { name: "Try again" }, { timeout: 4_000 });
  } finally {
    await app.close();
  }
});

it("renders per-item outcomes for a partially committed Update", async () => {
  let edited = false;
  const hostRef: { current?: Awaited<ReturnType<typeof mountSession>> } = {};
  const provider = new ScriptedProvider();
  const host = await mountSession({
    content: "First block.\n\nSecond block.",
    provider,
    directEditing: true,
    updateCheckpoint: async (_updateId, stage) => {
      const currentHost = hostRef.current;
      if (stage !== "checking" || edited || !currentHost) return;
      edited = true;
      const elementId = currentHost.elements[0]!.elementId;
      await currentHost.engineCommand("vc.HoldElement", { artifactId: currentHost.artifactId, elementId });
      await currentHost.engineCommand("vc.SaveElement", {
        artifactId: currentHost.artifactId,
        elementId,
        baseVersion: 1,
        element: { type: "paragraph", props: {}, text: "Human edit wins." },
      });
      await currentHost.engineCommand("vc.ReleaseHold", { artifactId: currentHost.artifactId, elementId });
    },
  });
  hostRef.current = host;
  try {
    const first = await host.agree("Edit first", host.elements[0]!.elementId),
      second = await host.agree("Edit second", host.elements[1]!.elementId);
    await host.reloadSession();
    provider.enqueueDefaultSequence([
      [
        {
          type: "output",
          json: {
            items: [
              {
                itemId: first.agreementId,
                action: "edit",
                elementIds: [host.elements[0]!.elementId],
                note: "Edit first.",
              },
              {
                itemId: second.agreementId,
                action: "edit",
                elementIds: [host.elements[1]!.elementId],
                note: "Edit second.",
              },
            ],
          },
        },
        { type: "usage", inputTokens: 20, outputTokens: 10, quality: "reported" },
        { type: "done", finishReason: "stop" },
      ],
      [
        {
          type: "output",
          json: {
            changes: [
              {
                op: "update",
                elementId: host.elements[0]!.elementId,
                element: { type: "paragraph", props: {}, text: "Agent first." },
              },
              {
                op: "update",
                elementId: host.elements[1]!.elementId,
                element: { type: "paragraph", props: {}, text: "Agent second." },
              },
            ],
            itemResults: [
              { itemId: first.agreementId, status: "addressed", elementIds: [host.elements[0]!.elementId] },
              { itemId: second.agreementId, status: "addressed", elementIds: [host.elements[1]!.elementId] },
            ],
          },
        },
        { type: "usage", inputTokens: 20, outputTokens: 10, quality: "reported" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    await (await host.screen.findByRole("button", { name: "Update now" }, { timeout: 4_000 })).click();
    await host.screen.findByText(/Some items were held back and are agreed again/, {}, { timeout: 4_000 });
    expect(host.screen.getByText(/Edit first — Not applied:.*direct edit/i)).toBeTruthy();
    expect(host.screen.getByText("Edit second — Applied")).toBeTruthy();
  } finally {
    await host.close();
  }
});

it("in Manual mode replies only after Ask agent", async () => {
  const provider = new ScriptedProvider(),
    app = await mountSession({ content: "A paragraph.", replyTrigger: "manual", provider });
  try {
    await app.comment("Please respond", app.elements[0]!.elementId);
    await app.reloadSession();
    provider.enqueueDefaultSequence([
      [
        {
          type: "tool_call",
          call: { id: "reply-1", name: "reply", arguments: { threadId: "$first_thread", body: "Manual reply." } },
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "Reply recorded." },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(provider.calls).toHaveLength(0);
    expect(app.screen.queryByText("Manual reply.")).toBeNull();
    await app.waitFor(() =>
      expect(app.screen.getByRole("button", { name: "Ask agent" }).hasAttribute("disabled")).toBe(false),
    );
    await app.screen.getByRole("button", { name: "Ask agent" }).click();
    expect(await app.screen.findByText("Manual reply.", {}, { timeout: 4_000 })).toBeTruthy();
  } finally {
    await app.close();
  }
});

it("shows the auto-agreement notice only for an active grant covering this session", async () => {
  const app = await mountSession({ content: "A paragraph." });
  try {
    expect(app.screen.queryByRole("link", { name: "Settings → Grants" })).toBeNull();
    await app.command("vc.CreateGrant", {
      scope: { sessionIds: ["other-session"] },
      capabilities: ["auto_agree_own_proposals"],
      limits: { spendMicros: 0 },
    });
    await app.command("vc.CreateGrant", {
      scope: { sessionIds: [app.sessionId] },
      capabilities: ["auto_agree_own_proposals"],
      limits: { spendMicros: 0 },
      expiresAt: "2026-10-29T00:00:00.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(app.screen.queryByRole("link", { name: "Settings → Grants" })).toBeNull();
    await app.command("vc.CreateGrant", {
      scope: { sessionIds: [app.sessionId] },
      capabilities: ["auto_agree_own_proposals"],
      limits: { spendMicros: 0 },
    });
    const grants = await app.query<
      Array<{ grantId: string; scope: { sessionIds?: string[] }; capabilities: string[] }>
    >("vc.Grants", {});
    expect(grants).toHaveLength(3);
    expect(grants[2]).toMatchObject({
      scope: { sessionIds: [app.sessionId] },
      capabilities: ["auto_agree_own_proposals"],
    });
    expect(await app.screen.findByRole("link", { name: "Settings → Grants" }, { timeout: 4_000 })).toBeTruthy();
    await app.command("vc.RevokeGrant", { grantId: grants[2]!.grantId });
    await app.waitFor(() => expect(app.screen.queryByRole("link", { name: "Settings → Grants" })).toBeNull(), {
      timeout: 4_000,
    });
  } finally {
    await app.close();
  }
});

it("refreshes the Session version and toast after vc.VersionCommitted", async () => {
  const app = await mountSession({ content: "A paragraph." });
  try {
    await app.reloadSession();
    expect(app.screen.getByText("v1")).toBeTruthy();
    await app.command("vc.RestoreVersion", { artifactId: app.artifactId, version: 1 });
    expect(await app.screen.findByText("v2", {}, { timeout: 4_000 })).toBeTruthy();
    expect(await app.screen.findByText("Updated to v2", {}, { timeout: 4_000 })).toBeTruthy();
  } finally {
    await app.close();
  }
});

it("uses friendly feedback labels and a single separator with relative comment times", async () => {
  const app = await mountSession({ content: "A paragraph." });
  try {
    await app.comment("Needs a response", app.elements[0]!.elementId);
    await app.reloadSession();
    const comment = await app.screen.findByText("Needs a response");
    const article = comment.closest("article");
    if (!article) throw new Error("Comment has no thread article");
    expect(app.within(article).getByText("Open")).toBeTruthy();
    expect(app.within(article).getByText(/^You · \d+ days? ago$/)).toBeTruthy();
    expect(app.within(article).queryByText(/You ·\s+·/)).toBeNull();
  } finally {
    await app.close();
  }
});

it("shows History, Snapshots, decision records, and version restore in the Session UI", async () => {
  const app = await mountSession({ content: "Original." });
  try {
    await app.command("vc.RestoreVersion", { artifactId: app.artifactId, version: 1 });
    await app.reloadSession();
    await app.screen.getByRole("button", { name: "History" }).click();
    expect(await app.screen.findByText("Version 2")).toBeTruthy();
    expect(await app.screen.findByText("Version 1")).toBeTruthy();
    await app.screen.getByRole("button", { name: "View version 1" }).click();
    expect(app.screen.getByText("Viewing v1 — read only")).toBeTruthy();
    await app.screen.getByRole("button", { name: "Back to latest" }).click();
    let confirmation = "";
    app.dom.confirm = (message) => {
      confirmation = message ?? "";
      return true;
    };
    await app.screen.getByRole("button", { name: "Restore version 1" }).click();
    expect(confirmation).toBe("Creates v3 with the content of v1. Nothing is lost.");
    await app.screen.getByRole("button", { name: "Why is this here?" }).click();
    expect(await app.screen.findByRole("region", { name: "Decision record" })).toBeTruthy();
  } finally {
    await app.close();
  }
});

it("creates a stable Snapshot, labels it, and exports its Markdown through the UI", async () => {
  const app = await mountSession({ content: "Snapshot export text." });
  try {
    await app.reloadSession();
    await app.screen.getByRole("button", { name: "Save Snapshot" }).click();
    app.fireEvent.change(app.screen.getByLabelText("Snapshot label"), { target: { value: "Sent to editor" } });
    await app.screen.getByRole("button", { name: "Create Snapshot" }).click();
    expect(await app.screen.findByText("Sent to editor")).toBeTruthy();
    await app.screen.getByRole("button", { name: "Export Snapshot" }).click();
    await app.screen.getByRole("button", { name: "Export Markdown" }).click();
    expect(await app.screen.findByText("Snapshot export text.")).toBeTruthy();
    await app.waitFor(() => expect(app.savedFiles.at(-1)?.bytes).toContain("Snapshot export text."), {
      timeout: 5_000,
    });
    const set = await app.query<
      Array<{ outputSetId: string; members: Array<{ artifactId: string; version: number }> }>
    >("vc.OutputSets", { sessionId: app.sessionId });
    expect(set[0]?.members).toMatchObject([{ artifactId: app.artifactId, version: 1 }]);
    await app.command("vc.RestoreVersion", { artifactId: app.artifactId, version: 1 });
    expect(
      (
        await app.query<Array<{ members: Array<{ version: number }> }>>("vc.OutputSets", { sessionId: app.sessionId })
      )[0]?.members[0]?.version,
    ).toBe(1);
  } finally {
    await app.close();
  }
}, 15_000);

it("shows a newly created MCP token once and omits its secret from the list", async () => {
  const app = await mountSession({ content: "A paragraph." });
  try {
    await app.screen.getByRole("button", { name: "Settings" }).click();
    await app.screen.findByRole("heading", { name: "Settings" });
    await app.screen.getByRole("button", { name: "AI assistant (MCP)" }).click();
    await app.screen.getByRole("button", { name: "Create access" }).click();
    await app.screen.getByRole("button", { name: "Can comment and agree" }).click();
    const secret = await app.screen.findByLabelText("MCP access token");
    const value = secret.getAttribute("value");
    expect(value).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    await app.screen.getByRole("button", { name: "Done" }).click();
    expect(app.screen.queryByLabelText("MCP access token")).toBeNull();
    const tokens = await app.query<Array<Record<string, unknown>>>("sys.AccessTokens", {});
    expect(JSON.stringify(tokens)).not.toContain(value);
  } finally {
    await app.close();
  }
});

it("keeps schema-defined settings outside edited fields unchanged across tabs", async () => {
  const app = await mountSession({ content: "Settings preservation." });
  try {
    await app.command("sys.SetSettings", {
      patch: {
        models: {
          default: { ...model, model: "before", baseUrl: "https://before.invalid/v1" },
          planner: model,
          writer: model,
        },
        budgets: {
          localTimeZone: "UTC",
          defaultTurnLimitMicros: 1234,
          defaultTurnTokenLimit: 321,
          realtimeDebounceSeconds: 7,
          toolCallLimit: 9,
          toolTimeoutMs: 12345,
          toolResultByteLimit: 23456,
        },
        sessions: {
          default: {
            replyTrigger: "batch",
            tokenLimit: 222,
            toolCallLimit: 8,
            replyRateLimitPerHour: 12,
            realtimeDebounceSeconds: 6,
            batchCommentThreshold: 4,
            batchIdleMinutes: 5,
            agentProfile: "Original profile",
            brief: "Original brief",
            planReview: true,
            directEditing: false,
            holdIdleMinutes: 11,
            updateIdleMinutes: 13,
          },
          [app.sessionId]: { tokenLimit: 345, directEditing: false },
        },
        trashRetentionDays: 45,
      },
    });
    await app.screen.getByRole("button", { name: "Settings" }).click();
    await app.screen.findByRole("heading", { name: "Settings" });
    await app.screen.findByLabelText("Model name");
    await app.screen.findByDisplayValue("https://before.invalid/v1");
    app.fireEvent.change(app.screen.getByLabelText("Model name"), { target: { value: "after" } });
    app.fireEvent.click(app.screen.getByRole("button", { name: "Save model" }));
    await app.waitFor(async () =>
      expect(
        (
          await app.query<{
            models: { default: { model: string }; planner: unknown };
            budgets: { toolCallLimit: number };
            sessions: Record<string, Record<string, unknown>>;
          }>("sys.Settings", {})
        ).models.default.model,
      ).toBe("after"),
    );
    let saved = await app.query<Settings>("sys.Settings", {});
    expect(saved.models.default?.baseUrl).toBe("https://before.invalid/v1");
    expect(saved.models.planner).toEqual(model);
    expect(saved.models.writer).toEqual(model);
    expect(saved.budgets).toMatchObject({
      localTimeZone: "UTC",
      defaultTurnLimitMicros: 1234,
      toolCallLimit: 9,
      toolResultByteLimit: 23456,
    });
    expect(saved.sessions[app.sessionId]).toMatchObject({ tokenLimit: 345, directEditing: false });
    await app.screen.getByRole("button", { name: "Agent" }).click();
    app.fireEvent.change(app.screen.getByLabelText("Agent profile"), { target: { value: "Updated profile" } });
    app.fireEvent.change(app.screen.getByLabelText("Agent brief"), { target: { value: "Updated brief" } });
    app.fireEvent.click(app.screen.getByRole("button", { name: "Save agent defaults" }));
    await app.waitFor(async () =>
      expect(
        (await app.query<{ sessions: Record<string, Record<string, unknown>> }>("sys.Settings", {})).sessions.default
          ?.agentProfile,
      ).toBe("Updated profile"),
    );
    saved = await app.query("sys.Settings", {});
    expect(saved.sessions[app.sessionId]).toMatchObject({ tokenLimit: 345, directEditing: false });
    expect(saved.sessions.default).toMatchObject({
      replyTrigger: "batch",
      tokenLimit: 222,
      toolCallLimit: 8,
      replyRateLimitPerHour: 12,
      realtimeDebounceSeconds: 6,
      agentProfile: "Updated profile",
      brief: "Updated brief",
      batchCommentThreshold: 4,
      batchIdleMinutes: 5,
      planReview: true,
      directEditing: false,
      holdIdleMinutes: 11,
      updateIdleMinutes: 13,
    });
    expect(saved.trashRetentionDays).toBe(45);
    for (const tab of ["Spending", "Grants", "Connected tools", "AI assistant (MCP)", "Data", "Appearance", "About"]) {
      await app.screen.getByRole("button", { name: tab }).click();
      if (tab === "Spending") {
        app.fireEvent.change(await app.screen.findByLabelText("Daily limit"), { target: { value: "5000" } });
        app.fireEvent.click(app.screen.getByRole("button", { name: "Save daily limit" }));
        await app.screen.findByText("Spending limit saved");
      }
      if (tab === "Data") {
        app.fireEvent.change(await app.screen.findByLabelText("Trash retention days"), { target: { value: "90" } });
        app.fireEvent.click(app.screen.getByRole("button", { name: "Save retention" }));
        await app.screen.findByText("Settings saved");
        saved = await app.query("sys.Settings", {});
        expect(saved.trashRetentionDays).toBe(90);
      }
      if (tab === "Appearance") app.fireEvent.click(app.screen.getByRole("button", { name: "dark" }));
      expect(await app.query("sys.Settings", {})).toEqual(saved);
    }
  } finally {
    await app.close();
  }
});

it("labels agreements made during a running Update for the next Update", async () => {
  const app = await mountSession({ content: "First block.\n\nSecond block.", planReview: true });
  try {
    const first = await app.agree("First request", app.elements[0]!.elementId);
    await app.reloadSession();
    app.provider.enqueueDefaultSequence([plan(first.agreementId, app.elements[0]!.elementId)]);
    await (await app.screen.findByRole("button", { name: "Update now" }, { timeout: 4_000 })).click();
    await app.screen.findByRole("button", { name: "Approve plan" }, { timeout: 4_000 });
    await app.comment("Second request", app.elements[0]!.elementId);
    await app.reloadSession();
    const refreshedThread = await app.screen.findByText("Second request", {}, { timeout: 4_000 });
    const article = refreshedThread.closest("article");
    if (!article) throw new Error("Second comment has no thread article");
    await app.within(article).getByRole("button", { name: "Agree as written" }).click();
    expect(await app.within(article).findByText("Will go into the next Update", {}, { timeout: 4_000 })).toBeTruthy();
  } finally {
    await app.close();
  }
});

async function mountSession(options: {
  content: string;
  provider?: ScriptedProvider;
  planReview?: boolean;
  directEditing?: boolean;
  replyTrigger?: "realtime" | "batch" | "manual";
  updateCheckpoint?: (updateId: string, stage: "checking") => Promise<void>;
}) {
  const provider = options.provider ?? new ScriptedProvider(),
    f = await fixture({
      modelProviders: { "openai-compatible": provider },
      updateCheckpoint: options.updateCheckpoint,
    });
  let server: Awaited<ReturnType<typeof startHttp>> | undefined,
    cleanupRenderer: () => void = () => undefined;
  try {
    const contract = new Contract(),
      tokenResult = await inProcess(f.rawEngine).command({
        commandId: "session-workflow-token",
        type: "sys.CreateAccessToken",
        payload: { name: "Session workflow", channel: "http", scope: "admin" },
      });
    if (!tokenResult.ok) throw new Error(tokenResult.error.message);
    const token = contract.read<SysCreateAccessTokenOperation["result"]>(
      "operations/sys.CreateAccessToken",
      tokenResult.result,
      "#/properties/result",
    ).token;
    server = await startHttp(f.rawEngine, { transport: "http" });
    const client = httpClient(server.url, token);
    const imported = await f.engine.command(ctx, {
      commandId: "workflow-import",
      type: "vc.ImportContent",
      payload: { title: "Workflow draft", format: "text", content: options.content },
    });
    if (!imported.ok) throw new Error(imported.error.message);
    const artifactId = contract.read<{ artifactId: string }>(
        "operations/vc.ImportContent",
        imported.result,
        "#/properties/result",
      ).artifactId,
      elements = await f.engine
        .query(ctx, { name: "vc.Elements", args: { artifactId } })
        .then((value) =>
          contract.read<import("../../../contract/src/index.js").Element[]>(
            "operations/vc.Elements",
            value,
            "#/properties/result",
          ),
        ),
      sessionResult = await f.engine.command(ctx, {
        commandId: "workflow-session",
        type: "vc.StartSession",
        payload: { title: "Workflow session", replyTrigger: options.replyTrigger ?? "manual" },
      });
    if (!sessionResult.ok) throw new Error(sessionResult.error.message);
    const sessionId = contract.read<{ sessionId: string }>(
      "operations/vc.StartSession",
      sessionResult.result,
      "#/properties/result",
    ).sessionId;
    const attachedResult = await f.engine.command(ctx, {
      commandId: "workflow-attach",
      type: "vc.AttachArtifact",
      payload: { sessionId, artifactId, role: "primary" },
    });
    if (!attachedResult.ok) throw new Error(attachedResult.error.message);
    const settingsResult = await f.engine.command(ctx, {
      commandId: "workflow-settings",
      type: "sys.SetSettings",
      payload: contract.read<Json>("json", {
        patch: {
          models: { default: model, planner: model, writer: model },
          sessions: {
            [sessionId]: { planReview: options.planReview ?? false, directEditing: options.directEditing ?? false },
          },
        },
      }),
    });
    if (!settingsResult.ok) throw new Error(`Settings setup failed: ${settingsResult.error.message}`);
    await f.engine.command(ctx, {
      commandId: "workflow-budget",
      type: "sys.SetBudget",
      payload: { account: { kind: "daily" }, limitMicros: 10_000_000 },
    });
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: `http://localhost/#/s/${encodeURIComponent(sessionId)}`,
    });
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
    Object.defineProperty(globalThis, "CSS", { value: dom.window.CSS, configurable: true });
    const testing = await import("@testing-library/react");
    cleanup = cleanupRenderer = testing.cleanup;
    const screen = testing.within(dom.window.document.body);
    const savedFiles: Array<{ name: string; bytes: string }> = [];
    const bridge: ContractBridge = {
      command: (type, payload, commandId = crypto.randomUUID()) =>
        client.command({ type, payload: contract.read<Json>("json", payload), commandId }),
      async query<T = unknown>(name: string, args: unknown): Promise<T> {
        const result = await client.query({ name, args: contract.read<Json>("json", args) });
        return contract.read<T>("json", result);
      },
      subscribe: (afterSeq, filter, onEvent) => {
        const controller = new AbortController();
        void (async () => {
          try {
            const subscription = contract.read<import("../../../contract/src/index.js").Subscription>("subscription", {
              afterSeq,
              filter,
            });
            for await (const event of client.subscribe(subscription, undefined, controller.signal)) onEvent(event);
          } catch {
            // Aborting or closing the host ends the test-only event stream.
          }
        })();
        return () => controller.abort();
      },
      putBlob: (bytes, mediaType) => client.putBlob(bytes, mediaType),
      getBlob: (hash) => client.getBlob(hash),
      blobUrl: (hash) => `vc-blob://${hash}`,
      app: {
        state: async () => "Connected",
        startEngine: async () => "Connected",
        saveProvider: async () => undefined,
        openMarkdown: async () => undefined,
        openExternal: async () => undefined,
        setTheme: async () => undefined,
        saveFiles: async (files) => {
          savedFiles.push(...files.map((file) => ({ name: file.name, bytes: new TextDecoder().decode(file.bytes) })));
        },
        copyText: async () => undefined,
        reveal: async () => undefined,
        workspacePath: async () => f.dir,
        restoreBackup: async () => undefined,
        mcpRelayPath: async () => "/vibecab-mcp",
        openMcpConfig: async () => undefined,
        nodeVersion: async () => "v26",
        version: async () => "test",
        onNewDraft: () => () => undefined,
        onImport: () => () => undefined,
        onTheme: () => () => undefined,
        onConnectionLost: () => () => undefined,
        onNavigate: () => () => undefined,
      },
    };
    dom.window.vibecab = bridge;
    testing.render(<App />);
    const command = async (type: string, payload: unknown) => {
        const result = await client.command({
          type,
          payload: contract.read<Json>("json", payload),
          commandId: crypto.randomUUID(),
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.result;
      },
      query = async <T,>(name: string, args: unknown) => {
        const result = await client.query({ name, args: contract.read<Json>("json", args) });
        return contract.read<T>("json", result);
      },
      comment = async (body: string, elementId: string) => {
        const result = await command("vc.Comment", {
          sessionId,
          body,
          anchor: { artifactId, elementId, seenVersion: 1 },
        });
        return contract.read<{ commentId: string }>("operations/vc.Comment", result, "#/properties/result");
      },
      agree = async (body: string, elementId: string) => {
        const posted = await comment(body, elementId),
          result = await command("vc.Agree", { commentId: posted.commentId, kind: "as_written" });
        return contract.read<{ agreementId: string }>("operations/vc.Agree", result, "#/properties/result");
      };
    const window = dom!.window;
    return {
      f,
      provider,
      artifactId,
      sessionId,
      elements,
      dom: window,
      screen: testing.within(window.document.body),
      savedFiles,
      fireEvent: testing.fireEvent,
      waitFor: testing.waitFor,
      within: testing.within,
      command,
      engineCommand: async (type: string, payload: unknown) => {
        const result = await f.engine.command(ctx, {
          type,
          payload: contract.read<Json>("json", payload),
          commandId: crypto.randomUUID(),
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.result;
      },
      query,
      comment,
      agree,
      async headVersion() {
        const result = await query<Array<{ artifactId: string; headVersion: number }>>("vc.Artifacts", {});
        return result.find((item) => item.artifactId === artifactId)?.headVersion;
      },
      async latestUpdateStatus() {
        const result = await query<{ updates: Array<{ updateId: string; status: string; createdAt: string }> }>(
          "vc.Updates",
          {
            artifactId,
          },
        );
        return result.updates.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.status;
      },
      async close() {
        cleanupRenderer();
        await new Promise((resolve) => setTimeout(resolve, 250));
        await server?.close();
        await f.close();
      },
      async reloadSession() {
        window.location.hash = `/s/${encodeURIComponent(sessionId)}`;
        window.dispatchEvent(new window.HashChangeEvent("hashchange"));
        await screen.findByRole("region", { name: "Session workflow" });
      },
    };
  } catch (error) {
    cleanupRenderer();
    await server?.close();
    await f.close();
    throw error;
  }
}

function plan(itemId: string, elementId: string): ModelEvent[] {
  return [
    {
      type: "output",
      json: { items: [{ itemId, action: "edit", elementIds: [elementId], note: "Rewrite this block." }] },
    },
    { type: "usage", inputTokens: 20, outputTokens: 10, quality: "reported" },
    { type: "done", finishReason: "stop" },
  ];
}

function write(itemId: string, elementId: string, text: string): ModelEvent[] {
  return [
    {
      type: "output",
      json: {
        changes: [{ op: "update", elementId, element: { type: "paragraph", props: {}, text } }],
        itemResults: [{ itemId, status: "addressed", elementIds: [elementId] }],
      },
    },
    { type: "usage", inputTokens: 20, outputTokens: 10, quality: "reported" },
    { type: "done", finishReason: "stop" },
  ];
}
