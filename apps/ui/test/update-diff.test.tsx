// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DiffResult, Element } from "../../../contract/generated/index.js";
import { UpdateDiff } from "../src/session/UpdateDiff.js";

afterEach(cleanup);

it("renders added, removed, changed, and moved markers independent of color", () => {
  const diff: DiffResult = {
    added: ["added"],
    removed: ["removed"],
    changed: ["changed"],
    moved: ["moved"],
    textDiffs: {
      changed: [
        { value: "old", removed: true },
        { value: "new", added: true },
      ],
    },
  };
  const baseElements: Element[] = [
    { elementId: "removed", type: "paragraph", parentId: null, order: "a0", props: {}, text: "Old paragraph" },
  ];
  const currentElements: Element[] = [
    { elementId: "added", type: "paragraph", parentId: null, order: "a0", props: {}, text: "New paragraph" },
    { elementId: "changed", type: "paragraph", parentId: null, order: "a1", props: {}, text: "New text" },
    { elementId: "moved", type: "paragraph", parentId: null, order: "a2", props: {}, text: "Moved text" },
  ];
  const { container } = render(
    <UpdateDiff
      diff={diff}
      baseElements={baseElements}
      currentElements={currentElements}
      showChanges
      onFocusElement={vi.fn()}
    />,
  );
  expect(screen.getByText(/Added paragraph/)).toBeTruthy();
  expect(screen.getByText(/Removed paragraph/)).toBeTruthy();
  expect(screen.getByText(/Moved/)).toBeTruthy();
  expect(container.querySelector(".diff-added")?.textContent).toContain("+ new");
  expect(container.querySelector(".diff-removed")?.textContent).toContain("− old");
});
