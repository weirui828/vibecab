import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { startE2EHost } from "./host.js";
import type { E2EHost } from "./host.js";

// The moving parts, with motion left on (the journey runs with reduced motion): the plumb line answers the
// pointer and stirs by itself now and then, Home has real tabs, and New Draft has one clear place for a file.

let host: E2EHost, page: Page, sessionId: string;
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ browser }) => {
  host = await startE2EHost(5265);
  page = await browser.newPage();
  await page.goto(host.url + "/");
  sessionId = await page.evaluate(async () => {
    const command = async (type: string, payload: unknown) => {
      const res = await fetch("/v1/commands/" + encodeURIComponent(type), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: crypto.randomUUID(), payload }),
      });
      return ((await res.json()) as { result: Record<string, string> }).result;
    };
    const content =
      "# Field notes\n\n" +
      Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1} about moss on basalt.`).join("\n\n");
    const { artifactId } = await command("vc.ImportContent", { format: "markdown", content, title: "Field notes" });
    const session = await command("vc.StartSession", { title: "Field notes" });
    await command("vc.AttachArtifact", { sessionId: session.sessionId, artifactId, role: "primary" });
    await command("vc.CaptureIdea", { text: "A map of the valley." });
    return session.sessionId!;
  });
});
test.afterAll(async () => {
  await page?.close();
  await host?.stop();
});

/** How far the plumb line is from hanging straight, at its widest, in pixels. */
const bend = () =>
  page.evaluate(() => {
    const d = document.querySelector(".vc-plumb path.vc-cable")?.getAttribute("d") ?? "";
    const xs = [...d.matchAll(/[ML]([\d.-]+) /g)].map((m) => Number(m[1]));
    return xs.length ? Math.max(...xs.map((x) => Math.abs(x - 14))) : -1;
  });

test("the plumb line answers the pointer on any block, settles, and stirs by itself now and then", async () => {
  await page.goto(`${host.url}/#/s/${sessionId}`);
  await expect(page.locator(".vc-doc h1")).toHaveText("Field notes");
  await expect(page.locator(".vc-plumb path.vc-cable")).toHaveAttribute("d", /^M14/);
  // Coming onto a paragraph (one with no thread on it) plucks the line beside it.
  await page.locator(".vc-doc > p").nth(2).hover();
  await expect.poll(bend, { timeout: 2000, intervals: [30] }).toBeGreaterThan(0.8);
  // It never swings wide, and it comes to rest again.
  expect(await bend()).toBeLessThan(6);
  await page.mouse.move(700, 80);
  await expect.poll(bend, { timeout: 8000 }).toBeLessThan(0.3);
  // Left alone, a faint shiver comes within a short while.
  let widest = 0;
  for (let i = 0; i < 100 && widest < 0.25; i++) {
    await page.waitForTimeout(200);
    widest = Math.max(widest, await bend());
  }
  expect(widest).toBeGreaterThan(0.25);
  expect(widest).toBeLessThan(4);
});

test("Home has three real tabs, and New Draft has one clear place for a file", async () => {
  await page.goto(host.url + "/#/");
  await expect(page.getByRole("tab", { selected: true })).toContainText("Sessions");
  await expect(page.getByRole("tabpanel").locator(".vc-line")).toHaveCount(1);
  await page.screenshot({ path: "test-results/screens/home-tab-sessions.png" });
  await page.getByRole("tab", { name: /^Drafts/ }).click();
  await expect(page).toHaveURL(/#\/drafts$/);
  await expect(page.getByRole("tab", { selected: true })).toContainText("Drafts");
  await expect(page.getByRole("tabpanel").locator(".vc-line")).toHaveCount(0);
  await expect(page.getByRole("tabpanel").getByText("Field notes").first()).toBeVisible();
  await page.screenshot({ path: "test-results/screens/home-tab-drafts.png" });
  await page.getByRole("tab", { name: /^Ideas/ }).click();
  await expect(page.getByRole("tabpanel").getByText("A map of the valley.")).toBeVisible();
  await page.screenshot({ path: "test-results/screens/home-tab-ideas.png" });
  // Back goes to the tab before, as with any address.
  await page.goBack();
  await expect(page.getByRole("tab", { selected: true })).toContainText("Drafts");

  await page.getByRole("button", { name: "New draft" }).click();
  const dialog = page.getByRole("dialog", { name: "New draft" });
  await expect(dialog.getByRole("button", { name: "Choose a file" })).toBeVisible();
  await page.screenshot({ path: "test-results/screens/new-draft-empty.png" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "Valley report.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><title>Valley</title><h1>Valley</h1>"),
  });
  await expect(dialog.getByText("Valley report.html")).toBeVisible();
  await page.screenshot({ path: "test-results/screens/new-draft-file.png" });
});
