const { chromium } = require("playwright");
const { default: AxeBuilder } = require("@axe-core/playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const base = process.env.VCAB_TEST_URL;
if (!base)
  throw new Error(
    "Set VCAB_TEST_URL to a daemon using a disposable database. Tests create projects and tasks.",
  );
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const request = async (path, method = "GET", body) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(r.ok, `${method} ${path}: ${r.status}`);
    return r.json();
  };
  async function auditView(name) {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    fs.mkdirSync("artifacts", { recursive: true });
    fs.writeFileSync(
      `artifacts/accessibility-${name}.json`,
      JSON.stringify(result.violations, null, 2),
    );
    assert.equal(
      result.violations.length,
      0,
      `${name} accessibility issues: ${result.violations.map((v) => v.id).join(", ")}`,
    );
  }
  try {
    await page.goto(base);
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await page.getByLabel("Project name", { exact: true }).fill("VibeCab");
    await page
      .locator("#project-form")
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await page.locator("#project-dialog").waitFor({ state: "hidden" });
    await page.locator("#workspace").waitFor({ state: "visible" });
    const project = await page.evaluate(() =>
      localStorage.getItem("vcab-project"),
    );
    await page.keyboard.press("n");
    await page
      .getByLabel("One idea per line")
      .fill(
        "Design the agent protocol\nBuild the task engine\nExplore semantic search",
      );
    await page
      .getByLabel("Context shared across these tasks")
      .fill("A small, focused foundation for VibeCab.");
    await page.getByRole("button", { name: "Save ideas", exact: true }).click();
    await page.locator("#capture-dialog").waitFor({ state: "hidden" });
    let tasks = await request(`/projects/${project}/tasks`);
    assert.equal(tasks.length, 3);
    const protocol = tasks.find((t) => t.title === "Design the agent protocol");
    const engine = tasks.find((t) => t.title === "Build the task engine");
    const card = (id) => page.locator(`#board [data-task-id="${id}"]`);
    await card(engine.id).click();
    await page
      .locator("#task-form")
      .getByLabel("Status", { exact: true })
      .selectOption("TODO");
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page
      .getByRole("button", { name: "Claim task", exact: true })
      .waitFor();
    await page
      .getByRole("checkbox", { name: "Design the agent protocol", exact: true })
      .check();
    await page
      .getByLabel("Why this relationship?")
      .fill("Agree on the contract before implementation.");
    await page
      .getByRole("button", { name: "Preview changes", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Apply dependencies", exact: true })
      .waitFor();
    await auditView("dependency-preview");
    await page
      .getByRole("button", { name: "Apply dependencies", exact: true })
      .click();
    await page.getByText("Dependencies updated.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(
      await card(engine.id).evaluate((e) => e.closest(".column").dataset.state),
      "blocked",
    );
    await card(protocol.id).click();
    await page
      .locator("#task-form")
      .getByLabel("Status", { exact: true })
      .selectOption("TODO");
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.getByRole("button", { name: "Claim task", exact: true }).click();
    await page
      .getByLabel("Result or handoff notes")
      .fill("Protocol reviewed and documented.");
    await page
      .getByRole("button", { name: "Mark complete", exact: true })
      .click();
    await page
      .getByText("Task completed. Dependents can move forward.", {
        exact: true,
      })
      .waitFor();
    await page.keyboard.press("Escape");
    assert.equal(
      await card(engine.id).evaluate((e) => e.closest(".column").dataset.state),
      "ready",
    );
    await card(engine.id).click();
    await page.getByRole("button", { name: "Claim task", exact: true }).click();
    await page
      .getByRole("button", { name: "Mark complete", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await request(`/projects/${project}/capture`, "POST", {
      request_id: "visual-extra",
      tasks: [
        {
          key: "connect",
          title: "Connect the MCP tools",
          dependencies: [engine.id],
          priority: 1,
          description: "Give every agent the same reliable set of tools.",
        },
        {
          key: "notes",
          title: "Save context between sessions",
          priority: 1,
          description: "Good handoffs keep the next agent moving.",
        },
        { key: "export", title: "Export a project snapshot", priority: 3 },
        {
          key: "layout",
          title: "Try a compact dependency view",
          backlog: true,
          priority: 3,
        },
      ],
    });
    await page.getByRole("button", { name: "Refresh", exact: false }).click();
    await page
      .getByRole("heading", { name: "Connect the MCP tools", exact: true })
      .waitFor();
    fs.mkdirSync("artifacts", { recursive: true });
    await page.screenshot({
      path: "artifacts/board-desktop.png",
      fullPage: true,
    });
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    fs.writeFileSync(
      "artifacts/accessibility.json",
      JSON.stringify(audit.violations, null, 2),
    );
    console.log(
      "Accessibility violations:",
      audit.violations.map((v) => ({ id: v.id, count: v.nodes.length })),
    );
    assert.equal(await page.locator("#metrics .mound-col").count(), 5);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "artifacts/board-dark.png", fullPage: true });
    await auditView("board-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page
      .getByRole("button", { name: "Polar night", exact: true })
      .click();
    assert.equal(
      await page
        .evaluate(() => [
          document.documentElement.dataset.theme,
          localStorage.getItem("vcab-theme"),
        ])
        .then((v) => v.join()),
      "dark,dark",
    );
    await auditView("board-polar-night");
    await page.getByRole("button", { name: "Auto", exact: true }).click();
    await page.keyboard.press("/");
    assert.equal(
      await page
        .locator("#search")
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await page
      .getByRole("searchbox", { name: "Search tasks" })
      .fill("semantic");
    assert.equal(await page.locator("#board .task-card").count(), 1);
    await page.getByRole("searchbox", { name: "Search tasks" }).fill("");
    await page
      .getByRole("button", { name: "Dependency plan", exact: false })
      .click();
    assert.equal(await page.locator("#plan").isVisible(), true);
    assert.ok((await page.locator(".plan-layer").count()) >= 3);
    await page.screenshot({
      path: "artifacts/dependency-plan.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Board", exact: false }).click();
    await card(engine.id).click();
    await page.screenshot({
      path: "artifacts/task-detail.png",
      fullPage: true,
    });
    await auditView("task-dialog");
    await page.keyboard.press("Escape");
    assert.equal(
      await card(engine.id).evaluate((e) => e === document.activeElement),
      true,
      "closing details restores task focus",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "artifacts/board-mobile.png",
      fullPage: true,
    });
    await auditView("mobile-board");
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "page must not overflow horizontally",
    );
    await page
      .getByRole("button", { name: "Capture ideas", exact: false })
      .click();
    await page
      .getByLabel("One idea per line")
      .fill("<img src=x onerror=alert(1)>");
    await page.getByRole("button", { name: "Save ideas", exact: true }).click();
    await page.locator("#capture-dialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#board img").count(), 0);
    assert.deepEqual(errors, []);
    assert.equal(
      audit.violations.length,
      0,
      "accessibility scan must pass; see artifacts/accessibility.json",
    );
    console.log(
      "PASS browser journey: project creation, batch capture, dependency preview/apply, claim/complete/unblock, search, plan view, responsive layout, escaped content, accessibility.",
    );
  } catch (e) {
    fs.mkdirSync("artifacts", { recursive: true });
    await page.screenshot({ path: "artifacts/failure.png", fullPage: true });
    console.error("Browser errors:", errors);
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
