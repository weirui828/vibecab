import { expect, it } from "vitest";
import { isQuiet, nextSweepDeferral, shouldForceSweep } from "../src/lifecycle/sweep-policy.js";

it("treats leased work and recent user writes as busy, but ignores queries and sweep leases", () => {
  const now = "2026-10-31T12:00:00.000Z";
  expect(isQuiet({ leasedJobs: [{ id: "sweep-1", kind: "trash.sweep" }], lastWriteAt: null }, now, "sweep-1")).toBe(
    true,
  );
  expect(isQuiet({ leasedJobs: [{ id: "agent-1", kind: "agent.reply" }], lastWriteAt: null }, now, "sweep-1")).toBe(
    false,
  );
  expect(isQuiet({ leasedJobs: [], lastWriteAt: "2026-10-31T11:59:30.000Z" }, now, "sweep-1")).toBe(false);
  expect(isQuiet({ leasedJobs: [], lastWriteAt: "2026-10-31T11:59:00.000Z" }, now, "sweep-1")).toBe(true);
});

it("backs off sweep retries at five minutes, fifteen minutes, then hourly and forces after 24 hours", () => {
  const now = "2026-10-31T12:00:00.000Z";
  expect(nextSweepDeferral(now, 0)).toBe("2026-10-31T12:05:00.000Z");
  expect(nextSweepDeferral(now, 1)).toBe("2026-10-31T12:15:00.000Z");
  expect(nextSweepDeferral(now, 2)).toBe("2026-10-31T13:00:00.000Z");
  expect(nextSweepDeferral(now, 20)).toBe("2026-10-31T13:00:00.000Z");
  expect(shouldForceSweep("2026-11-01T11:59:59.999Z", "2026-10-31T12:00:00.000Z")).toBe(false);
  expect(shouldForceSweep("2026-11-01T12:00:00.000Z", "2026-10-31T12:00:00.000Z")).toBe(true);
});
