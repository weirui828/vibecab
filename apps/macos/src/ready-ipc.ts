import type { IpcMainInvokeEvent } from "electron";

export type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export interface IpcMainLike {
  handle(channel: string, listener: IpcHandler): void;
}

export function waitForEngineHandlers(ipcMain: IpcMainLike, engineReady: Promise<void>): IpcMainLike {
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, async (event, ...args) => {
        await engineReady;
        return listener(event, ...args);
      });
    },
  };
}
