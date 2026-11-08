import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mappedEvents, unshownEvents } from "../src/live/refreshMap.js";

// A new engine event the app does not map leaves screens stale until a reload (it happened with project items).
it("maps every engine event to the queries it makes stale, or lists it as not shown", () => {
  const events = readdirSync(join(import.meta.dirname, "../../../contract/schemas/events"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
  const known = new Set([...mappedEvents(), ...unshownEvents]);
  expect(events.filter((e) => !known.has(e))).toEqual([]);
  expect([...known].filter((e) => !events.includes(e))).toEqual([]);
});
