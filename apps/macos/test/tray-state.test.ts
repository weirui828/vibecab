import { describe, expect, it } from "vitest";
import { menuStatus, recentSessionItems } from "../src/tray-state.js";

describe("tray state", () => {
  it("combines engine, Update, and attention status", () => {
    expect(menuStatus({ running: true, updateTitle: "Launch post", needsYou: 3 })).toEqual([
      "Engine running",
      "Updating ‘Launch post’…",
      "3 items need you",
    ]);
  });
  it("shows stopped state and limits recent sessions to five", () => {
    expect(menuStatus({ running: false, needsYou: 0 })).toEqual(["Engine stopped"]);
    expect(
      recentSessionItems(Array.from({ length: 7 }, (_, i) => ({ sessionId: String(i), title: `S${i}` }))),
    ).toHaveLength(5);
  });
});
