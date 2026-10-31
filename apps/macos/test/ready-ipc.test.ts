import { describe, expect, it, vi } from "vitest";
import { waitForEngineHandlers } from "../src/ready-ipc.js";

describe("ready IPC handlers", () => {
  it("registers before engine readiness and waits for the engine before running a query", async () => {
    let resolveEngine!: () => void;
    const engineReady = new Promise<void>((resolve) => {
        resolveEngine = resolve;
      }),
      handlers = new Map<string, (...args: unknown[]) => unknown>(),
      ipcMain = {
        handle: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => handlers.set(channel, listener)),
      },
      query = vi.fn(async (input: unknown) => ({ input })),
      readyIpcMain = waitForEngineHandlers(ipcMain, engineReady);

    readyIpcMain.handle("vibe:query", (_event, input) => query(input));
    expect(ipcMain.handle).toHaveBeenCalledOnce();

    const invoke = handlers.get("vibe:query");
    expect(invoke).toBeDefined();
    const result = invoke?.({}, { name: "vc.Artifacts" });
    expect(query).not.toHaveBeenCalled();

    resolveEngine();
    await expect(result).resolves.toEqual({ input: { name: "vc.Artifacts" } });
    expect(query).toHaveBeenCalledOnce();
  });
});
