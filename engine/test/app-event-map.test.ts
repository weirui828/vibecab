import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { Contract } from "../../contract/src/index.js";

it("keeps the app refresh map aligned with event schemas and query operations", () => {
  const markdown = readFileSync("docs/design/app-events.md", "utf8"),
    contract = new Contract(),
    eventFiles = readdirSync("contract/schemas/events").filter((file) => file.endsWith(".json")),
    eventNames = new Set(
      eventFiles.map((file) => {
        const schema: unknown = JSON.parse(readFileSync(resolve("contract/schemas/events", file), "utf8"));
        if (!schema || typeof schema !== "object") throw new Error("Invalid event schema");
        const id = Reflect.get(schema, "$id");
        return typeof id === "string"
          ? id
              .split("/")
              .at(-1)
              ?.replace(/\.json$/, "")
          : "";
      }),
    ),
    rows = markdown.split("\n").filter((line) => line.startsWith("| `"));
  expect(rows.length).toBeGreaterThan(5);
  for (const row of rows) {
    const columns = row.split("|"),
      events = [...(columns[1] ?? "").matchAll(/`((?:vc|sys)\.[A-Z][A-Za-z]+)`/g)].map((match) => match[1]!);
    expect(events.length, row).toBeGreaterThan(0);
    for (const name of events) expect(eventNames.has(name), row).toBe(true);
    const queries = [...(columns[3] ?? "").matchAll(/`((?:vc|sys)\.[A-Z][A-Za-z]+)`/g)].map((match) => match[1]!);
    for (const query of queries) expect(contract.operations.get(query)?.kind, row).toBe("query");
  }
});
