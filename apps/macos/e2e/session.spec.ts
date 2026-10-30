import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import axe from "axe-core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { status } from "../../../host/src/index.js";
import { Contract } from "../../../contract/src/index.js";
import type { VcImportContentOperation, VcStartSessionOperation } from "../../../contract/generated/index.js";

const appPath = resolve(import.meta.dirname, "..");

test("imports, comments on text, receives a reply, and catches up after relaunch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vibecab-session-e2e-")),
    script = join(workspace, "fake-provider.json"),
    contract = new Contract();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await writeFile(
      script,
      JSON.stringify({
        defaultSequence: [
          [
            {
              type: "tool_call",
              call: {
                id: "reply-1",
                name: "reply",
                arguments: {
                  threadId: "$first_thread",
                  body: "I can tighten that sentence.",
                  proposal: [{ label: "Tighten sentence", text: "The paragraph has a clearer sentence." }],
                },
              },
            },
            { type: "done", finishReason: "tool_calls" },
          ],
          [
            { type: "text_delta", text: "Reply recorded." },
            { type: "done", finishReason: "stop" },
          ],
          [
            {
              type: "text_delta",
              text: '{"items":[{"itemId":"$first_item","action":"edit","elementIds":["$first_element"],"note":"Apply the agreed rewrite."}]}',
            },
            { type: "done", finishReason: "stop" },
          ],
          [
            {
              type: "text_delta",
              text: JSON.stringify({
                changes: [
                  {
                    op: "update",
                    elementId: "$first_element",
                    element: { type: "paragraph", props: {}, text: "The paragraph has a clearer sentence." },
                  },
                ],
                itemResults: [{ itemId: "$first_item", status: "addressed", elementIds: ["$first_element"] }],
              }),
            },
            { type: "done", finishReason: "stop" },
          ],
        ],
      }),
    );
    app = await launchApp(workspace, script);
    let page = await app.firstWindow();
    await page.addInitScript({ content: axe.source });
    await page.reload();
    await page.getByRole("button", { name: "Get started" }).click();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.getByRole("heading", { name: "Your Drafts" })).toBeVisible();
    await expect.poll(() => seriousAxeViolations(page)).toBe(0);

    const imported = await page.evaluate(async () =>
      window.vibecab.command("vc.ImportContent", {
        title: "Imported draft",
        format: "markdown",
        content: "The paragraph includes a sentence worth discussing.",
      }),
    );
    if (!imported.ok) throw new Error(imported.error.message);
    const artifact = contract.read<VcImportContentOperation["result"]>(
      "operations/vc.ImportContent",
      imported.result,
      "#/properties/result",
    );
    const sessionResult = await page.evaluate(async () =>
      window.vibecab.command("vc.StartSession", { title: "Writing session", replyTrigger: "realtime" }),
    );
    if (!sessionResult.ok) throw new Error(sessionResult.error.message);
    const session = contract.read<VcStartSessionOperation["result"]>(
      "operations/vc.StartSession",
      sessionResult.result,
      "#/properties/result",
    );
    await page.evaluate(
      async ({ sessionId, artifactId }) =>
        window.vibecab.command("vc.AttachArtifact", { sessionId, artifactId, role: "primary" }),
      { sessionId: session.sessionId, artifactId: artifact.artifactId },
    );
    await page.evaluate(
      (sessionId) =>
        window.vibecab.command("sys.SetSettings", {
          patch: {
            models: {
              default: {
                provider: "openai-compatible",
                baseUrl: "https://example.invalid/v1",
                model: "scripted",
                capabilities: {
                  tools: true,
                  jsonSchemaOutput: true,
                  streaming: true,
                  maxContextTokens: 4096,
                  reportsUsage: false,
                },
                pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
              },
            },
            sessions: { [sessionId]: { realtimeDebounceSeconds: 1, updateIdleMinutes: 0.02 } },
          },
        }),
      session.sessionId,
    );
    const budget = await page.evaluate(async () =>
      window.vibecab.command("sys.SetBudget", { account: { kind: "daily" }, limitMicros: 10_000_000 }),
    );
    if (!budget.ok) throw new Error(budget.error.message);
    await page.evaluate(
      (sessionId) => (window.location.hash = "/s/" + encodeURIComponent(sessionId)),
      session.sessionId,
    );
    await expect(page.getByText("The paragraph includes a sentence worth discussing.")).toBeVisible();
    await expect.poll(() => seriousAxeViolations(page)).toBe(0);
    await page.waitForTimeout(3_200);
    await selectText(page, "worth discussing");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByRole("textbox", { name: "Comment" }).fill("Could you explain this choice?");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Comment posted" })).toBeVisible();
    await page.waitForTimeout(2_500);
    const replyState = await page.evaluate(
      async (sessionId) => ({
        turns: await window.vibecab.query("vc.AgentTurns", { sessionId }),
        threads: await window.vibecab.query("vc.Threads", { sessionId }),
      }),
      session.sessionId,
    );
    if (!JSON.stringify(replyState.threads).includes("I can tighten that sentence."))
      throw new Error(`Scripted reply was not posted: ${JSON.stringify(replyState)}`);
    await expect(page.getByText("I can tighten that sentence.", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Agree with option: Tighten sentence" }).click();
    await expect(page.getByText("Applied in v2", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "v1 → v2" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("The paragraph has a clearer sentence.", { exact: true })).toBeVisible();
    const screenshots = join(appPath, "test-results");
    await mkdir(screenshots, { recursive: true });
    await page.evaluate(() => window.vibecab.app.setTheme("light"));
    await page.screenshot({ path: join(screenshots, "a3-full-loop-light.png"), fullPage: true });
    await page.evaluate(() => window.vibecab.app.setTheme("dark"));
    await page.screenshot({ path: join(screenshots, "a3-full-loop-dark.png"), fullPage: true });

    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();
    app = await launchApp(workspace, script);
    page = await app.firstWindow();
    await page.evaluate(
      (sessionId) => (window.location.hash = "/s/" + encodeURIComponent(sessionId)),
      session.sessionId,
    );
    await expect(page.getByText("Since you were here")).toBeVisible();
    await expect(page.getByText("New reply · I can tighten that sentence.", { exact: true })).toBeVisible();
    await expect(page.getByText("I can tighten that sentence.", { exact: true })).toBeVisible();
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();
    app = undefined;
    await expect.poll(async () => (await status(workspace)).running).toBe(false);
  } finally {
    await app?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

async function launchApp(workspace: string, fakeProvider: string) {
  return electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      VIBECAB_DEV: "1",
      VIBECAB_KEYSTORE: "memory",
      VIBECAB_WORKSPACE_DIR: workspace,
      VIBECAB_NODE: process.execPath,
      VIBECAB_FAKE_PROVIDER: fakeProvider,
    },
  });
}

async function seriousAxeViolations(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(async () => {
    const axeApi = Reflect.get(window, "axe");
    const results = await axeApi.run(document);
    return results.violations.filter((violation: { impact: string }) =>
      ["serious", "critical"].includes(violation.impact),
    ).length;
  });
}

async function selectText(page: import("@playwright/test").Page, quote: string): Promise<void> {
  await page.locator("[data-element-id]").evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.textContent ?? "",
        start = text.indexOf(target);
      if (start >= 0) {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + target.length);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      node = walker.nextNode();
    }
    throw new Error("Could not select requested document text");
  }, quote);
}
