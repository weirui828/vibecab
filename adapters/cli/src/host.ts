import { start as startHost } from "../../../host/src/index.js";
import { status, stop, serve } from "../../../host/src/index.js";
import type { HostStatus } from "../../../host/src/types.js";

export { status, stop, serve };

export function start(workspace: string): Promise<HostStatus> {
  const development = process.env.VIBECAB_DEV === "1",
    hostEntry = development ? process.env.VIBECAB_HOST_ENTRY : undefined,
    fakeProvider = development ? process.env.VIBECAB_FAKE_PROVIDER : undefined;
  return startHost(workspace, {
    ...(hostEntry ? { hostEntry } : {}),
    ...(fakeProvider ? { fakeProvider } : {}),
  });
}
