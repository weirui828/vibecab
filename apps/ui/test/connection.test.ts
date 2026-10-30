import { expect, it } from "vitest";
import { connectionTransition } from "../src/connection.js";

it("moves through startup, connected, stopped, unreachable, and recovery states", () => {
  const starting = connectionTransition("Engine stopped", "starting"),
    connected = connectionTransition(starting, "connected"),
    unreachable = connectionTransition(connected, "unreachable"),
    stopped = connectionTransition(unreachable, "stopped"),
    recovered = connectionTransition(stopped, "connected");
  expect([starting, connected, unreachable, stopped, recovered]).toEqual([
    "Starting",
    "Connected",
    "Engine unreachable",
    "Engine stopped",
    "Connected",
  ]);
});
