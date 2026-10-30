// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { VcResumeViewOperation } from "../../../contract/generated/index.js";
import { ResumeCard } from "../src/session/ResumeCard.js";

afterEach(cleanup);

it("shows each catch-up item once and acknowledges with Got it", () => {
  const onGotIt = vi.fn(),
    resume: VcResumeViewOperation["result"] = {
      sessionId: "session",
      fromSeq: 1,
      toSeq: 9,
      versions: [{ artifactId: "draft", version: 2, changedElements: 1 }],
      comments: [{ commentId: "comment-1", body: "A new note", threadId: "thread-1" }],
      replies: [{ commentId: "comment-2", body: "A reply", threadId: "thread-1" }],
      awaitingAgreement: [{ itemId: "proposal-1", threadId: "thread-2" }],
      conflicts: [{ conflictId: "conflict-1", threadId: "thread-3" }],
      updates: [{ updateId: "update-1", status: "failed" }],
      changesSinceOutputSet: [],
    };
  const { container } = render(<ResumeCard resume={resume} onGotIt={onGotIt} />);
  expect(container.querySelectorAll("[data-resume-item]")).toHaveLength(6);
  expect(screen.getByText("Since you were here")).toBeTruthy();
  screen.getByRole("button", { name: "Got it" }).click();
  expect(onGotIt).toHaveBeenCalledOnce();
});
// @vitest-environment jsdom
