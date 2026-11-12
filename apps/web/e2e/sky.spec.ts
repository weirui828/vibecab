import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { startE2EHost } from "./host.js";
import type { E2EHost } from "./host.js";

// Ideas as a night sky, in a real browser with motion on: the stars are drawn, a new idea arrives and joins its
// kin, a star can be chosen, and the list is one switch away.

const ideas = [
  "A calmer first run with fewer steps before the first draft",
  "Let the first run skip the model setup and start with a sample draft",
  "Show a sample draft on first run so onboarding teaches by doing",
  "Comment on a sentence by selecting it, not the whole paragraph",
  "Voice notes as comments on a paragraph",
  "Let comments carry a suggested replacement sentence",
  "Export a Snapshot as a PDF to send",
  "Share a Snapshot as a single link",
  "Export the draft with its comments as an appendix",
  "Polar night theme with a slow aurora",
  "A sound of wind when the theme changes to night",
];

let host: E2EHost, page: Page;
test.beforeAll(async ({ browser }) => {
  host = await startE2EHost(5266);
  page = await browser.newPage();
  await page.goto(host.url + "/");
  await page.evaluate(async (texts) => {
    for (const text of texts)
      await fetch("/v1/commands/vc.CaptureIdea", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: crypto.randomUUID(), payload: { text } }),
      });
  }, ideas);
});
test.afterAll(async () => {
  await page?.close();
  await host?.stop();
});

/** How many points of the sky's canvas have something drawn on them. */
const drawn = () =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".vc-sky canvas");
    const data = canvas?.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    if (data) for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 24) count++;
    return count;
  });

test("ideas are a sky of stars; a new one flies in and joins its kin; the list is one switch away", async () => {
  await page.goto(host.url + "/#/ideas");
  const sky = page.locator(".vc-sky canvas");
  await expect(sky).toBeVisible();
  await expect(sky).toHaveAttribute("aria-label", /^11 ideas as stars, \d+ groups? of close ones/);
  await expect.poll(drawn).toBeGreaterThan(400);
  await page.screenshot({ path: "test-results/screens/sky.png" });

  // A new idea is typed where ideas are always typed. It says where it went.
  const box = page.getByRole("textbox", { name: "New idea" });
  await box.fill("Comments by voice while reading a paragraph on the phone");
  await box.press("Enter");
  await expect(page.locator(".vc-sky-said")).toContainText(/It joins|It found one that is close/);
  await expect(page.locator(".vc-sky-said")).toContainText("Closest: Voice notes as comments on a paragraph");
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/screens/sky-flight.png" });
  await expect(sky).toHaveAttribute("aria-label", /^12 ideas as stars/);
  // It is chosen when it arrives: its words, what it is close to, and what can be made of the group.
  const card = page.locator(".vc-sky-card");
  await expect(card.locator(".text")).toHaveText("Comments by voice while reading a paragraph on the phone");
  await expect(card.getByRole("list", { name: "Closest" }).getByRole("button").first()).toHaveText(
    "Voice notes as comments on a paragraph",
  );
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "test-results/screens/sky-landed.png" });
  // One of its kin can be chosen from the card, and the group gathered into a Project.
  await card.getByRole("list", { name: "Closest" }).getByRole("button").first().click();
  await expect(card.locator(".text")).toHaveText("Voice notes as comments on a paragraph");
  await card.getByRole("button", { name: /^New project from these \d+$/ }).click();
  await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The same ideas in words, and the choice is kept.
  await page.getByRole("group", { name: "Show as" }).getByRole("button", { name: "List" }).click();
  await expect(page.locator(".vc-sky")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Voice notes as comments on a paragraph — edit" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Voice notes as comments on a paragraph — edit" })).toBeVisible();
  await expect(page.locator(".vc-sky")).toHaveCount(0);
});
