import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { terms } from "../src/copy/terms.js";
import { errorMessage } from "../src/copy/errors.js";

it("centralizes the visible domain labels and maps contract errors", () => {
  expect(terms).toEqual({
    draft: "Draft",
    document: "Document",
    snapshot: "Snapshot",
    session: "Session",
    update: "Update",
    agree: "Agree",
    decline: "Decline",
    open: "Open",
    discussing: "Discussing",
    agreed: "Agreed",
    scheduled: "Scheduled",
    applied: "Applied",
    declined: "Declined",
    superseded: "Superseded",
  });
  expect(errorMessage("budget_exceeded")).toBe("Spending limit reached for today.");
  expect(errorMessage("stale_base")).toBe("This changed while you were editing.");
  expect(errorMessage("unknown_code")).toBe("Something went wrong. Try again.");
});

it("does not render engine names as literal JSX text", () => {
  const source = readFileSync(new URL("../src/view/App.tsx", import.meta.url), "utf8");
  expect(source).not.toMatch(/>\s*(?:artifact|OutputSet|vc\.[A-Z][A-Za-z]+)\s*</i);
});
