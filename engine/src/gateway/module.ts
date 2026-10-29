import { createModule } from "../modules/create-module.js";
import type { EngineModuleHost } from "../kernel/module-registry.js";

export function gatewayModule(host: EngineModuleHost) {
  return createModule(
    "gateway",
    host,
    ["sys.SetSettings", "sys.SetProviderKeyRef", "sys.SetBudget"],
    ["sys.Capabilities", "sys.Settings", "sys.Usage", "sys.Budgets"],
  );
}
