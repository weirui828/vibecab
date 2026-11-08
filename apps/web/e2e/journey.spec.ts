import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { startE2EHost } from "./host.js";
import type { E2EHost } from "./host.js";

// One person's first hour with VibeCab, in a real browser against a real engine and the scripted model
// (apps/web/dev/fake-provider.json): first run → a Draft → a comment → the agent's options → agree → Update →
// changes → Snapshot → history. Every screen is checked with axe; screenshots land in test-results/screens.

// Loaded through the debugging protocol: the page's strict CSP (no inline scripts) stays on during the test.
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
let host: E2EHost, page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  host = await startE2EHost(5263);
  page = await browser.newPage({ reducedMotion: "reduce" });
});
test.afterAll(async () => {
  await page?.close();
  await host?.stop();
});

/** No serious or critical accessibility problems on the current screen. */
async function accessible(name: string) {
  await page.evaluate(axeSource);
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run(): Promise<{ violations: Array<{ id: string; impact?: string; nodes: unknown[] }> }> };
      }
    ).axe;
    const result = await axe.run();
    return result.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map(
        (v) =>
          `${v.id} (${v.impact}): ` +
          (v.nodes as Array<{ target: string[]; failureSummary?: string }>)
            .map((n) => n.target.join(" ") + " — " + (n.failureSummary ?? "").split("\n").slice(-1)[0])
            .join(" | "),
      );
  });
  expect(violations, `axe on ${name}`).toEqual([]);
}

async function screens(name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [
      ["desktop", { width: 1440, height: 900 }],
      ["phone", { width: 375, height: 812 }],
    ] as const) {
      await page.setViewportSize(size);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `test-results/screens/${name}-${scheme}-${label}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("first run: sign in, choose a model, land on an empty Home", async () => {
  await page.goto(host.launch);
  await expect(page.getByRole("heading", { name: "Welcome to VibeCab." })).toBeVisible();
  await accessible("first run");
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByLabel("Model").fill("scripted");
  await page.getByLabel("API key").fill("e2e-test-key");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { name: "A daily limit" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: "Later" }).click();
  await expect(page.getByRole("heading", { name: "Nothing drafted yet." })).toBeVisible();
  await accessible("empty Home");
  await screens("home-empty");
});

test("Settings: the key is saved and never shown; the agent replies quickly", async () => {
  await page.goto(host.url + "/#/settings");
  await expect(page.getByText(/Key saved/)).toBeVisible();
  expect(await page.content()).not.toContain("e2e-test-key");
  const agent = page.getByRole("region", { name: "The agent" });
  await agent.getByLabel("Wait before replying (seconds)").fill("1");
  await agent.getByRole("button", { name: "Save", exact: true }).click();
  await accessible("Settings");
  await screens("settings");
});

test("a Draft from a Markdown file opens in its own session", async () => {
  await page.goto(host.url + "/#/");
  await page.getByRole("button", { name: "New draft" }).click();
  await page.getByText("Import Markdown").click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "Field notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Field notes\n\nMoss on basalt near the lake.\n\nA second paragraph."),
  });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/#\/s\/session_/);
  await expect(page.locator(".vc-doc h1")).toHaveText("Field notes");
  await accessible("session");
});

test("comment on words, the agent answers with options, agree, and an Update writes the next version", async () => {
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.getByRole("button", { name: "Realtime" }).click();
  await page.keyboard.press("Escape");
  // Select "basalt" the way a reader would, then use the floating Comment button.
  await page.evaluate(() => {
    const text = [...document.querySelectorAll<HTMLElement>("[data-text-for]")].find((n) =>
      n.textContent?.includes("basalt"),
    )!;
    const node = text.firstChild!.firstChild ?? text.firstChild!;
    const at = node.textContent!.indexOf("basalt");
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + "basalt".length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.locator(".vc-pick").click();
  await page.getByRole("textbox", { name: "Comment on the selected words" }).fill("Name the rock.");
  await page.keyboard.press("Control+Enter");
  const thread = page.locator(".vc-inline .vc-thread", { hasText: "Name the rock." });
  await expect(thread).toBeVisible();
  await expect(thread.getByText("Covibe: two ways to make the title carry the idea.")).toBeVisible({ timeout: 20_000 });
  await thread.getByRole("button", { name: "Agree with option: Name the idea" }).click();
  await expect(thread.getByText("Agreed — waiting for the next Update")).toBeVisible();
  await accessible("session with threads");
  await screens("session");
  await page.getByRole("button", { name: "Update now" }).click();
  await expect(page.locator(".vc-strip")).toContainText("Version 2", { timeout: 20_000 });
  await expect(page.locator(".vc-doc h1")).toHaveText("Covibe: shaping one piece of work together");
  await page.locator(".vc-strip").getByRole("button", { name: "Changes" }).click();
  await expect(page.locator(".vc-changes .vc-changed")).toHaveCount(1);
  await expect(page.locator(".vc-changes ins")).toContainText("shaping");
  await accessible("changes view");
  await screens("changes");
});

test("save a Snapshot and find it in history", async () => {
  await page.locator(".vc-strip").getByRole("button", { name: "Clean" }).click();
  await page.getByRole("button", { name: "Save a snapshot" }).click();
  await page.getByLabel("Label (optional)").fill("First draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "History" }).click();
  const history = page.getByRole("complementary", { name: "History" });
  await expect(history.getByText("First draft").first()).toBeVisible();
  await expect(history.getByText("Update by the agent for you")).toBeVisible();
  await accessible("history");
  await screens("history");
});

test("the other screens are accessible", async () => {
  for (const [path, heading] of [
    ["/#/", /^Good (morning|afternoon|evening)\.|Working late\./],
    ["/#/drafts", "Drafts"],
    ["/#/sessions", "Sessions"],
    ["/#/ideas", "Ideas"],
    ["/#/projects", "Projects"],
    ["/#/trash", "Trash"],
  ] as const) {
    await page.goto(host.url + path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await accessible(path);
  }
  await page.goto(host.url + "/#/");
  await screens("home");
});
