import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import process from "node:process";
import { fileURLToPath } from "node:url";

export async function configurePackagedFuses(appPath) {
  if (!appPath) throw new Error("Pass the packaged Electron .app path");
  await flipFuses(appPath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await configurePackagedFuses(process.argv[2]);
}
