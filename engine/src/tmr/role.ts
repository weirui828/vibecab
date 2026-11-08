import { createHash } from "node:crypto";
import { fail, type Json, type Settings } from "../../../contract/src/index.js";
import type { ModuleContext } from "../kernel/module-registry.js";
import { independentReviewPreset } from "./presets/independent-review.js";

/**
 * A run's panel, process and limits, from the request or else from the TMR role (W13): each panel agent takes part
 * under its label, the process is independent review, and the role's cap limits what one run may spend.
 */
export function fromRole(ctx: ModuleContext, p: Record<string, Json>): Record<string, Json> {
  if (p.participants && p.processSpec && p.limits) return p;
  const settings = ctx.contract.read<Settings>("settings", ctx.settings()),
    role = settings.roles?.tmr,
    panel = (role?.panel ?? []).filter((member) => settings.models[member.agentId]);
  const participants =
    p.participants ??
    panel.map((member, i) => {
      const model = settings.models[member.agentId];
      return {
        participantId: "p" + (i + 1),
        roleLabel: member.label?.trim() || model?.name?.trim() || member.agentId,
        modelRef: member.agentId,
        systemPromptHash: createHash("sha256")
          .update(model?.instructions ?? "")
          .digest("hex"),
      };
    });
  if (!Array.isArray(participants) || participants.length === 0)
    fail("invalid", "Add agents to the TMR panel in Settings, or send participants");
  const spendMicros = role?.spendMicros;
  if (!p.limits && spendMicros === undefined)
    fail("invalid", "Set a spending cap per TMR run in Settings, or send limits");
  return {
    ...p,
    participants,
    processSpec:
      p.processSpec ??
      ctx.contract.read<Json>(
        "json",
        independentReviewPreset(
          participants.map((x) => ctx.contract.read<{ participantId: string }>("json", x).participantId),
        ),
      ),
    limits: p.limits ?? { spendMicros: spendMicros ?? 0 },
  };
}
