// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Element } from "../../../contract/generated/index.js";
import { DocumentView } from "../src/document/DocumentView.js";

afterEach(cleanup);

const elements: Element[] = [
  {
    elementId: "el_00000000000000000000000001",
    type: "heading",
    parentId: null,
    order: "a0",
    props: { level: 1 },
    text: "Heading",
  },
  {
    elementId: "el_00000000000000000000000002",
    type: "paragraph",
    parentId: null,
    order: "a1",
    props: {},
    text: "Paragraph",
  },
  { elementId: "el_00000000000000000000000003", type: "list", parentId: null, order: "a2", props: { ordered: false } },
  {
    elementId: "el_00000000000000000000000004",
    type: "list_item",
    parentId: "el_00000000000000000000000003",
    order: "a0",
    props: {},
    text: "List item",
  },
  { elementId: "el_00000000000000000000000005", type: "quote", parentId: null, order: "a3", props: {}, text: "Quote" },
  {
    elementId: "el_00000000000000000000000006",
    type: "code_block",
    parentId: null,
    order: "a4",
    props: { language: "ts" },
    text: "const x = 1",
  },
  {
    elementId: "el_00000000000000000000000007",
    type: "table",
    parentId: null,
    order: "a5",
    props: { headerRow: true },
  },
  {
    elementId: "el_00000000000000000000000008",
    type: "table_row",
    parentId: "el_00000000000000000000000007",
    order: "a0",
    props: {},
  },
  {
    elementId: "el_00000000000000000000000009",
    type: "table_cell",
    parentId: "el_00000000000000000000000008",
    order: "a0",
    props: {},
    text: "Cell",
  },
  {
    elementId: "el_0000000000000000000000000A",
    type: "image",
    parentId: null,
    order: "a6",
    props: { alt: "Diagram", caption: "Caption" },
    blobHash: "a".repeat(64),
  },
  { elementId: "el_0000000000000000000000000B", type: "divider", parentId: null, order: "a7", props: {} },
  {
    elementId: "el_0000000000000000000000000C",
    type: "callout",
    parentId: null,
    order: "a8",
    props: { tone: "warning" },
    text: "Notice",
  },
];

it("renders each document element type and preserves its element id", () => {
  const { container } = render(
    <DocumentView artifactId="artifact" version={1} elements={elements} onComment={vi.fn()} />,
  );
  expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy();
  expect(screen.getByText("List item")).toBeTruthy();
  expect(screen.getByText("const x = 1")).toBeTruthy();
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Diagram" })).toBeTruthy();
  expect(screen.getByText("Caption")).toBeTruthy();
  expect(screen.getByText("Notice")).toBeTruthy();
  expect(container.querySelectorAll("[data-element-id]")).toHaveLength(elements.length);
});

it("offers a comment affordance on every piece, including nested blocks", () => {
  const onComment = vi.fn(),
    { container } = render(
      <DocumentView artifactId="artifact" version={1} elements={elements} onComment={onComment} />,
    );
  const buttons = screen.getAllByRole("button", { name: /^Comment on this / });
  // A <tr> cannot contain a button; its cells carry the affordance instead.
  expect(buttons).toHaveLength(elements.filter((element) => element.type !== "table_row").length);
  const listItem = elements[3]!;
  const itemButton = container.querySelector(`[data-element-id="${listItem.elementId}"] > .block-comment`);
  expect(itemButton).toBeTruthy();
  fireEvent.click(itemButton!);
  expect(onComment).toHaveBeenCalledWith(listItem);
});

it("selects the innermost block on double-click instead of its container", () => {
  const onComment = vi.fn();
  render(<DocumentView artifactId="artifact" version={1} elements={elements} onComment={onComment} />);
  fireEvent.doubleClick(screen.getByText("List item"));
  expect(onComment).toHaveBeenCalledTimes(1);
  expect(onComment).toHaveBeenCalledWith(elements[3]!);
});

it("opens the comment slot under the selected piece and marks it selected", () => {
  const list = elements[2]!,
    listItem = elements[3]!,
    { container } = render(
      <DocumentView
        artifactId="artifact"
        version={1}
        elements={elements}
        onComment={vi.fn()}
        selectedElementId={listItem.elementId}
        commentSlot={<div className="sentinel-slot" />}
      />,
    ),
    slot = container.querySelector(".sentinel-slot");
  expect(slot?.previousElementSibling?.getAttribute("data-element-id")).toBe(list.elementId);
  expect(container.querySelector(`[data-element-id="${listItem.elementId}"]`)?.getAttribute("data-selected")).toBe(
    "true",
  );
});
// @vitest-environment jsdom
