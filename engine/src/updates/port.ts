import type { Json } from "../../../contract/src/index.js";
import type { ModuleContext } from "../kernel/module-registry.js";
import { canonical } from "../kernel/canonical.js";

export type FindingHead = { applicability: "current" | "revised" | "removed"; currentContent?: string };
export interface UpdatesPort {
  findingHead(ctx: ModuleContext, input: { artifactId: string; elementId: string; elementHash: string }): FindingHead;
}

export function updatesPort(): UpdatesPort {
  return {
    findingHead(ctx, input) {
      const version = ctx.repository.version(input.artifactId),
        hash = version.manifest[input.elementId];
      if (!hash) return { applicability: "removed" };
      const element = ctx.repository
        .elements(input.artifactId, version.version)
        .find((item) => item.elementId === input.elementId);
      return {
        applicability: hash === input.elementHash ? "current" : "revised",
        ...(element ? { currentContent: toText(ctx.contract.read<Json>("json", element)) } : {}),
      };
    },
  };
}

function toText(element: Json): string {
  const content = field(element, "text");
  return typeof content === "string" ? content : canonical(element);
}
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
