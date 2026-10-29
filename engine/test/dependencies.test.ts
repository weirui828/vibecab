import { expect, it } from "vitest";
import { ids } from "./helpers.js";
import { random } from "../src/kernel/dependencies.js";
it("generates deterministic unique test IDs using the ULID alphabet", () => {
  const a = ids(),
    b = ids(),
    values = Array.from({ length: 2048 }, () => a.next("el_"));
  expect(new Set(values).size).toBe(values.length);
  for (const value of values) {
    expect(value).toMatch(/^el_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(value).toBe(b.next("el_"));
  }
});
it("reproduces seeded randomness independently per instance", () => {
  const a = random(42),
    b = random(42);
  expect(Array.from({ length: 20 }, a)).toEqual(Array.from({ length: 20 }, b));
});
