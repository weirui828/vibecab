import { createHash } from "node:crypto";
import type { Element } from "../../../contract/src/index.js";
import { canonical } from "../kernel/canonical.js";
export { canonical } from "../kernel/canonical.js";
export function revisionHash(element: Element): string {
  return createHash("sha256").update(canonical(element)).digest("hex");
}
