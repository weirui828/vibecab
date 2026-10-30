import canonicalize from "canonicalize";
import { fail } from "../../../contract/src/index.js";

export function canonical(value: unknown): string {
  let result: unknown;
  try {
    result = canonicalize(value);
  } catch {
    fail("invalid", "Value cannot be canonicalized");
  }
  if (typeof result !== "string") fail("invalid", "Value cannot be canonicalized");
  return result;
}
