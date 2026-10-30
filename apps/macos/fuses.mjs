import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import { resolve } from "node:path";

await flipFuses(resolve("node_modules/electron/dist/Electron.app"), {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
});
