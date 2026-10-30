import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("declares an arm64 macOS app and a one-command packaging script", async () => {
  const root = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    },
    mac = await readFile(new URL("../electron-builder.config.mjs", import.meta.url), "utf8");
  expect(root.scripts["app:package"]).toBeDefined();
  expect(mac).toContain('appId: "app.vibecab.mac"');
  expect(mac).toContain('minimumSystemVersion: "14.0"');
  expect(mac).toContain('{ target: "dmg", arch: ["arm64"] }');
  expect(mac).toContain('{ target: "dir", arch: ["arm64"] }');
});
