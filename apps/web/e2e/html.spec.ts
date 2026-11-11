import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { startE2EHost } from "./host.js";
import type { E2EHost } from "./host.js";

// An HTML file as a Draft, in a real browser (task H1): it looks like itself, its scripts run but cannot reach
// VibeCab or the network, and a block can be commented on. jsdom cannot load a sandboxed frame, so this is here.

const file = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quarterly field report</title>
<style>body{font:16px/1.6 Georgia,serif;margin:0}main{max-width:820px;margin:0 auto;padding:40px 32px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:16px}.card{border:1px solid silver;border-radius:10px;padding:16px}</style>
<link rel="stylesheet" href="https://example.invalid/outside.css"></head>
<body><main><h1>Quarterly field report</h1><p class="lede">What we measured on the tundra this season.</p>
<section class="cards"><div class="card"><b>412</b> plots surveyed</div><div class="card"><b>61%</b> moss cover</div></section>
<p id="probe">script not run</p><img id="pixel" src="https://example.invalid/pixel.png" alt="">
<script>
  var seen = "no";
  try { seen = parent.document ? "yes" : "no"; } catch (error) { seen = "no"; }
  document.getElementById("probe").textContent = "script ran; app in reach: " + seen + "; origin: " + self.origin;
  fetch("/v1/queries/vc.Sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .then(function () { document.getElementById("probe").textContent += "; network: yes"; })
    .catch(function () { document.getElementById("probe").textContent += "; network: no"; });
</script></main></body></html>`;

let host: E2EHost, page: Page;
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ browser }) => {
  host = await startE2EHost(5264);
  page = await browser.newPage({ reducedMotion: "reduce" });
});
test.afterAll(async () => {
  await page?.close();
  await host?.stop();
});

test("an HTML file is shown as itself in a closed frame, and a block takes a comment", async () => {
  await page.goto(host.url + "/");
  // Import through the app's own bridge, as the New Draft dialog does.
  const sessionId = await page.evaluate(async (content) => {
    const command = async (type: string, payload: unknown) => {
      const res = await fetch("/v1/commands/" + encodeURIComponent(type), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: crypto.randomUUID(), payload }),
      });
      return ((await res.json()) as { result: Record<string, string> }).result;
    };
    const { artifactId } = await command("vc.ImportContent", { format: "html", content });
    const { sessionId } = await command("vc.StartSession", { title: "Field report review" });
    await command("vc.AttachArtifact", { sessionId, artifactId, role: "primary" });
    return sessionId;
  }, file);
  await page.goto(`${host.url}/#/s/${sessionId}`);

  const frame = page.locator("iframe.vc-html-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  const inside = page.frameLocator("iframe.vc-html-frame");
  await expect(inside.locator("h1")).toHaveText("Quarterly field report");
  // Its own styles apply: the two cards sit side by side.
  const cards = await inside.locator(".card").evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().top));
  expect(cards[0]).toBe(cards[1]);
  // Its script ran, in an origin of its own, and could reach neither the app nor the network.
  await expect(inside.locator("#probe")).toHaveText("script ran; app in reach: no; origin: null; network: no");
  // The outside stylesheet and image are stopped by the frame's policy before anything leaves this computer.
  const stopped: string[] = [],
    answered: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("example.invalid")) stopped.push(request.failure()?.errorText ?? "");
  });
  page.on("response", (response) => response.url().includes("example.invalid") && answered.push(response.url()));
  await page.reload();
  await expect(inside.locator("#probe")).toContainText("network: no");
  expect(answered).toEqual([]);
  expect(stopped).toHaveLength(2);
  for (const reason of stopped) expect(reason).toBe("csp");

  // The frame is as tall as the file, and the page knows where each block is.
  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(300);
  // Five blocks have a place on the page: the heading, the lede, two cards, the probe. The script and the
  // image that was not loaded take no room, so they get no box.
  await expect(page.locator(".vc-html-block")).toHaveCount(5);
  const heading = await inside.locator("h1").boundingBox(),
    box = await page.locator(".vc-html-block").first().boundingBox();
  expect(Math.abs((heading?.y ?? 0) - (box?.y ?? -99))).toBeLessThan(2);

  // Pointing at a block in the frame brings up the page's comment button beside it; the comment lands on it.
  await inside.locator(".lede").hover();
  await page.getByRole("button", { name: "Comment on this block" }).click();
  await page.getByRole("textbox").first().fill("Say which season.");
  await page.keyboard.press("ControlOrMeta+Enter");
  const thread = page.locator(".vc-thread", { hasText: "Say which season." });
  await expect(thread).toBeVisible();
  const anchored = await page.evaluate(async (id) => {
    const res = await fetch("/v1/queries/vc.Threads", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { sessionId: id } }),
    });
    const threads = (await res.json()) as Array<{ comments: Array<{ body: string; anchor?: { elementId: string } }> }>;
    return threads.flatMap((t) => t.comments).find((c) => c.body === "Say which season.")?.anchor?.elementId;
  }, sessionId);
  expect(anchored).toMatch(/^el_/);
  // The plumb line has a bead for it.
  await expect(page.locator(".vc-bead")).toHaveCount(1);
  // The block's box stays where the block is, with the thread's mark beside it.
  const marked = await page.locator(".vc-html-block[data-mark]").boundingBox(),
    lede = await inside.locator(".lede").boundingBox();
  expect(Math.abs((marked?.y ?? -99) - (lede?.y ?? 0))).toBeLessThan(2);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: "test-results/screens/html-draft.png" });
});

test("New Draft takes an HTML file from this computer", async () => {
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Add a draft" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a draft" });
  await dialog.getByText("Import HTML").click();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "second-page.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><title>Second page</title><h1>Second page</h1><p>Short and plain.</p>"),
  });
  // The file's name is offered as the title.
  await expect(dialog.getByRole("textbox", { name: "Title" })).toHaveAttribute("placeholder", "second-page");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.frameLocator("iframe.vc-html-frame").locator("h1")).toHaveText("Second page");
  await expect(page.locator(".vc-html-block")).toHaveCount(2);
  // Both Drafts are in the session, each under its own tab.
  await expect(page.locator(".vc-draft-tabs a")).toHaveCount(2);
});
