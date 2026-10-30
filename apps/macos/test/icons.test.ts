import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("generates macOS icons and a monochrome template from the original mark", async () => {
  const temp = await mkdtemp(join(tmpdir(), "vibecab-icons-"));
  try {
    execFileSync(process.execPath, [join(import.meta.dirname, "../scripts/generate-icons.mjs"), temp]);
    expect(execFileSync("sips", ["-g", "pixelWidth", join(temp, "icon-1024.png")], { encoding: "utf8" })).toContain(
      "1024",
    );
    const icns = await readFile(join(temp, "icon.icns"));
    expect(icns.subarray(0, 4).toString()).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(icns.includes(Buffer.from("ic10"))).toBe(true);
    execFileSync("iconutil", ["-c", "iconset", join(temp, "icon.icns"), "-o", join(temp, "round-trip.iconset")]);
    expect(execFileSync("sips", ["-g", "pixelWidth", join(temp, "iconTemplate.png")], { encoding: "utf8" })).toContain(
      "16",
    );
    expect(
      execFileSync("sips", ["-g", "pixelWidth", join(temp, "iconTemplate@2x.png")], { encoding: "utf8" }),
    ).toContain("32");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);
