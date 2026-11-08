import { expect, it } from "vitest";
import { attentionBySession } from "../src/live/workspace.js";
import type { SessionRow } from "../src/live/workspace.js";

const session = (sessionId: string, state: SessionRow["state"]): SessionRow => ({
  sessionId,
  title: sessionId,
  state,
  replyTrigger: "manual",
  createdAt: "2026-11-01T00:00:00.000Z",
  artifactIds: [],
});

it("groups the inbox by session and leaves out ended sessions, which nothing can be done in", () => {
  const attention = attentionBySession(
    [
      { kind: "agreed_item", id: "a1", sessionId: "live" },
      { kind: "unread_reply", id: "r1", sessionId: "live" },
      { kind: "agreed_item", id: "a2", sessionId: "over" },
      { kind: "new_version", id: "v1" },
    ],
    [session("live", "active"), session("over", "ended")],
  );
  expect([...attention.keys()]).toEqual(["live"]);
  expect(attention.get("live")?.map((i) => i.id)).toEqual(["a1", "r1"]);
});
