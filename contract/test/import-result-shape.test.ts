import { expect, it } from "vitest";
import { Contract } from "../src/index.js";

it("accepts the schema-defined ImportContent result returned to the app bridge", () => {
  const contract = new Contract();
  expect(() =>
    contract.read(
      "operations/vc.ImportContent",
      { artifactId: "art_abc", version: 1, idMap: { "new:0": "el_abc" } },
      "#/properties/result",
    ),
  ).not.toThrow();
});
