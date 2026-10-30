import { getCurrentFuseWire, FuseState, FuseV1Options } from "@electron/fuses";
import { describe, expect, it } from "vitest";

const packagedApp = process.env.VIBECAB_PACKAGED_APP;

describe.skipIf(!packagedApp)("packaged Electron fuses", () => {
  it("disables Node execution and inspector fuses", async () => {
    const wire = await getCurrentFuseWire(packagedApp!);
    expect(wire[FuseV1Options.RunAsNode]).toBe(FuseState.DISABLE);
    expect(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(FuseState.DISABLE);
    expect(wire[FuseV1Options.EnableNodeCliInspectArguments]).toBe(FuseState.DISABLE);
  });
});
