export type HostEndpoints = {
  httpUrl: string;
  cliUrl: string;
  mcpUrl: string;
};

export type HostStatus = { running: false } | ({ running: true; pid: number; startedAt: string } & HostEndpoints);

export type HostStartOptions = { nodePath?: string; hostEntry?: string; fakeProvider?: string };
export type HostStopOptions = { timeoutMs?: number };
