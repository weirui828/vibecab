// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WindowDragRegion } from "../src/view/WindowDragRegion.js";

afterEach(cleanup);

it("renders an accessible hidden title-bar drag strip with Electron drag styling", () => {
  const { container } = render(<WindowDragRegion />),
    region = container.querySelector(".window-drag-region"),
    styles = readFileSync(resolve("apps/ui/src/styles.css"), "utf8"),
    app = readFileSync(resolve("apps/ui/src/view/App.tsx"), "utf8");

  expect(region).not.toBeNull();
  expect(region?.getAttribute("aria-hidden")).toBe("true");
  expect(styles).toMatch(/\.window-drag-region\s*\{[^}]*-webkit-app-region:\s*drag/s);
  expect(app).toContain("<WindowDragRegion />");
});
