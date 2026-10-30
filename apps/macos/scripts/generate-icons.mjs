#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const output = resolve(process.argv[2] ?? join(root, "apps/macos/build"));
const source = resolve(process.argv[3] ?? join(root, "apps/macos/assets/brand/vc-mark-2048.jpg"));
const iconsetTemp = await mkdtemp(join(tmpdir(), "vibecab-iconset-"));
const iconset = `${iconsetTemp}.iconset`;
await rename(iconsetTemp, iconset);
await mkdir(output, { recursive: true });
await mkdir(join(iconset, "ModuleCache"), { recursive: true });
try {
  execFileSync("swift", [
    "-module-cache-path",
    join(iconset, "ModuleCache"),
    join(here, "template-icon.swift"),
    source,
    iconset,
    join(output, "icon-1024.png"),
    join(output, "iconTemplate.png"),
    join(output, "iconTemplate@2x.png"),
  ]);
  await rm(join(iconset, "ModuleCache"), { recursive: true, force: true });
  const iconPath = join(output, "icon.icns");
  try {
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", iconPath], { stdio: "ignore" });
  } catch {
    // Some recent macOS SDK iconutil builds reject valid RGBA iconsets; preserve the same PNG renditions in ICNS form.
    const entries = [
      ["icp4", "icon_16x16.png"],
      ["icp5", "icon_32x32.png"],
      ["icp6", "icon_32x32@2x.png"],
      ["ic07", "icon_128x128.png"],
      ["ic08", "icon_256x256.png"],
      ["ic09", "icon_512x512.png"],
      ["ic10", "icon_512x512@2x.png"],
    ];
    const chunks = await Promise.all(
      entries.map(async ([type, name]) => {
        const image = await readFile(join(iconset, name));
        const header = Buffer.alloc(8);
        header.write(type, 0, "ascii");
        header.writeUInt32BE(image.length + header.length, 4);
        return Buffer.concat([header, image]);
      }),
    );
    const body = Buffer.concat(chunks),
      header = Buffer.alloc(8);
    header.write("icns", 0, "ascii");
    header.writeUInt32BE(body.length + header.length, 4);
    await writeFile(iconPath, Buffer.concat([header, body]));
  }
} finally {
  if (process.env.VIBECAB_KEEP_ICONSET !== "1") await rm(iconset, { recursive: true, force: true });
}
