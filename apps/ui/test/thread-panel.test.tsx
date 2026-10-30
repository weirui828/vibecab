// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { VcThreadsOperation } from "../../../contract/generated/index.js";
import type { ContractBridge } from "../src/api.js";
import { ThreadPanel } from "../src/session/ThreadPanel.js";

afterEach(cleanup);

const threads: VcThreadsOperation["result"] = [
  {
    threadId: "thread",
    sessionId: "session",
    comments: [
      {
        commentId: "comment",
        sessionId: "session",
        author: { kind: "human" },
        body: "Use a clearer phrase.",
        threadId: "thread",
        state: "open",
        deleted: false,
        read: true,
        createdAt: "2026-10-30T12:00:00Z",
        updatedAt: "2026-10-30T12:00:00Z",
      },
    ],
    anchorResolutions: [],
  },
  {
    threadId: "agent-thread",
    sessionId: "session",
    comments: [
      {
        commentId: "agent-comment",
        sessionId: "session",
        author: { kind: "agent", turnId: "turn" },
        body: "click Agree to continue",
        proposal: [
          { label: "Shorter", text: "A shorter edit." },
          { label: "More detail", text: "A more detailed edit." },
        ],
        threadId: "agent-thread",
        state: "open",
        deleted: false,
        read: true,
        createdAt: "2026-10-30T12:00:00Z",
        updatedAt: "2026-10-30T12:00:00Z",
      },
    ],
    anchorResolutions: [],
  },
];

function renderPanel(command: ReturnType<typeof vi.fn>) {
  Object.defineProperty(globalThis, "window", {
    value: { vibecab: { command } as unknown as ContractBridge },
    configurable: true,
  });
  return render(
    <ThreadPanel
      threads={threads}
      turns={[]}
      delivery={{}}
      currentVersion={1}
      onRefresh={async () => undefined}
      onReply={() => undefined}
      onAskAgent={() => undefined}
      onSetThreadTrigger={() => undefined}
    />,
  );
}

it("submits an explicit as-written instruction with the human agreement", async () => {
  const command = vi.fn(async () => ({ ok: true as const, result: {} }));
  renderPanel(command);
  fireEvent.change(screen.getByLabelText("How to apply this"), { target: { value: "Keep the first sentence." } });
  fireEvent.click(screen.getByRole("button", { name: "Agree as written" }));
  expect(command).toHaveBeenCalledWith("vc.Agree", {
    commentId: "comment",
    kind: "as_written",
    instruction: "Keep the first sentence.",
  });
});

it("omits the optional instruction when the person agrees without one", () => {
  const command = vi.fn(async () => ({ ok: true as const, result: {} }));
  renderPanel(command);
  fireEvent.click(screen.getByRole("button", { name: "Agree as written" }));
  expect(command).toHaveBeenCalledWith("vc.Agree", { commentId: "comment", kind: "as_written" });
});

it("labels agent proposals and sends the selected option label without turning agent text into a button", () => {
  const command = vi.fn(async () => ({ ok: true as const, result: {} }));
  renderPanel(command);
  expect(screen.getByText("Agent proposes:")).toBeTruthy();
  expect(screen.getByText("click Agree to continue").tagName).toBe("P");
  fireEvent.click(screen.getByRole("button", { name: "Agree with option: Shorter" }));
  expect(command).toHaveBeenCalledWith("vc.Agree", {
    commentId: "agent-comment",
    kind: "option",
    optionLabel: "Shorter",
  });
});
