import type { OperationMeta } from "../generated/index.js";
export const unsupportedGroups: readonly {
  prefix: string;
  commands: string;
  queries: string;
  effect?: OperationMeta["effect"];
}[] = [
  { prefix: "sys", commands: "OpenWorkspace", queries: "", effect: "admin" },
  { prefix: "vc", commands: "", queries: "" },
  { prefix: "vc", commands: "", queries: "" },
  { prefix: "vc", commands: "MarkHandled", queries: "DeliveryState" },
  { prefix: "vc", commands: "", queries: "" },
  {
    prefix: "vc",
    commands: "CreateGrant RevokeGrant",
    queries: "Grants",
    effect: "admin",
  },
  {
    prefix: "sys",
    commands: "ConnectToolServer DisconnectToolServer SetToolPolicy",
    queries: "ToolServers ToolCalls",
    effect: "admin",
  },
  { prefix: "vc", commands: "RequestReview", queries: "" },
  {
    prefix: "tmr",
    commands: "CancelRun ResumeRun",
    queries: "Runs Run Report Findings",
  },
  { prefix: "vc", commands: "", queries: "" },
  {
    prefix: "vc",
    commands: "",
    queries: "",
  },
  {
    prefix: "sys",
    commands: "RestoreBackup",
    queries: "",
    effect: "admin",
  },
  { prefix: "sys", commands: "", queries: "", effect: "admin" },
];
