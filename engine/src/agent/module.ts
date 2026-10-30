import { createModule } from "../modules/create-module.js";
import type { EngineModuleHost } from "../kernel/module-registry.js";
import type { AgentTurn, Json, Job } from "../../../contract/src/index.js";

export function agentModule(host: EngineModuleHost) {
  const engineModule = createModule(
    "agent",
    host,
    [
      "vc.AskAgent",
      "vc.CreateGrant",
      "vc.RevokeGrant",
      "vc.ConnectToolServer",
      "vc.RefreshToolServer",
      "vc.DisconnectToolServer",
      "vc.SetToolPolicy",
    ],
    ["vc.AgentTurns", "vc.Manifest", "vc.DeliveryState", "vc.Grants", "vc.ToolServers", "vc.ToolCalls"],
    {
      "agent.reply": "rerun",
      "agent.trigger": "rerun",
      "agent.update.trigger": "rerun",
      "agent.tool_server.refresh": "rerun",
    },
  );
  engineModule.recover = (context) => {
    for (const job of context.repository.jobs()) {
      if (job.kind !== "agent.reply" || !["leased", "interrupted"].includes(job.state)) continue;
      const turnId = payloadString(job, "turnId");
      if (!turnId) continue;
      const row = context.repository.feedback("agent-turn", turnId);
      if (!row) continue;
      const turn = context.contract.read<AgentTurn>("agent-turn", row);
      if (turn.status !== "running") continue;
      context.repository.saveFeedback(
        "agent-turn",
        turnId,
        context.contract.read<Json>("json", {
          ...turn,
          status: "uncertain",
          updatedAt: context.clock.now(),
          completedAt: context.clock.now(),
        }),
      );
      context.repository.jobState(job.id, "uncertain");
    }
  };
  return engineModule;
}

function payloadString(job: Job, key: string): string | undefined {
  const payload = job.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const value = Reflect.get(payload, key);
  return typeof value === "string" ? value : undefined;
}
