import { Fragment, useMemo, useState } from "react";
import type { DiffResult, Element } from "../../../../contract/generated/index.js";
import { Alert } from "@wei/design-system";
import type { ReactNode } from "react";
import { InlineText } from "./inline-markdown.js";

const commentLabels: Record<Element["type"], string> = {
  heading: "heading",
  paragraph: "paragraph",
  list: "list",
  list_item: "list item",
  quote: "quote",
  code_block: "code block",
  table: "table",
  table_row: "table row",
  table_cell: "table cell",
  image: "image",
  divider: "divider",
  callout: "callout",
};

export function DocumentView({
  artifactId,
  version,
  elements,
  onComment,
  diff,
  showChanges,
  selectedElementId,
  commentSlot,
  annotations,
  commentable = true,
}: {
  artifactId: string;
  version: number;
  elements: Element[];
  onComment: (element: Element, locator?: { quote: string; prefix: string; suffix: string }) => void;
  diff?: DiffResult;
  showChanges?: boolean;
  selectedElementId?: string;
  commentSlot?: ReactNode;
  /** Inline discussions keyed by the top-level block they belong to, rendered under that block. */
  annotations?: Record<string, ReactNode>;
  commentable?: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(400);
  const sorted = useMemo(() => [...elements].sort((a, b) => a.order.localeCompare(b.order)), [elements]);
  // The composer opens after the top-level block that contains the selection: a comment belongs
  // next to the piece being discussed, not at the end of the Document.
  const selectedTopId = useMemo(() => {
    if (!selectedElementId) return undefined;
    const byId = new Map(sorted.map((element) => [element.elementId, element]));
    let current = byId.get(selectedElementId);
    if (!current) return undefined;
    while (current.parentId !== null) {
      const parent = byId.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current.elementId;
  }, [selectedElementId, sorted]);
  const children = (parentId: string) => sorted.filter((element) => element.parentId === parentId).map(renderElement);
  const propsText = (element: Element, key: string) =>
    key in element.props ? String(Reflect.get(element.props, key)) : "";
  const renderElement = (element: Element): ReactNode => {
    const changeKind = diff?.added.includes(element.elementId)
      ? "added"
      : diff?.moved.includes(element.elementId)
        ? "moved"
        : showChanges && diff?.changed.includes(element.elementId)
          ? "changed"
          : undefined;
    const selected = selectedElementId === element.elementId;
    const common = {
      "data-element-id": element.elementId,
      ...(changeKind ? { "data-change": changeKind } : {}),
      ...(selected ? { "data-selected": "true" } : {}),
    };
    const interact = commentable
      ? {
          onDoubleClick: (event: { stopPropagation: () => void }) => {
            // Nested blocks bubble. The innermost piece must win, or a list item or cell can
            // never be commented on: the outer list/table would swallow the selection.
            event.stopPropagation();
            onComment(element);
          },
        }
      : {};
    const gutter = commentable ? (
      <button
        type="button"
        className="block-comment"
        aria-label={`Comment on this ${commentLabels[element.type]}`}
        title={`Comment on this ${commentLabels[element.type]}`}
        onClick={(event) => {
          event.stopPropagation();
          onComment(element);
        }}
      />
    ) : null;
    // Leaf and container blocks are wrapped so the affordance sits beside them without nesting a
    // button inside <ul>, <table>, <tr> or <hr>, where it would be invalid markup.
    const wrap = (node: ReactNode) => (
      <div key={element.elementId} {...common} {...interact} className="doc-block doc-block-row">
        {node}
        {gutter}
      </div>
    );
    const parts = "text" in element ? diff?.textDiffs[element.elementId] : undefined,
      text =
        "text" in element && showChanges && parts ? (
          <>
            {parts.map((part, index) =>
              part.added ? (
                <span key={index} className="diff-added">
                  + {part.value}
                </span>
              ) : part.removed ? (
                <span key={index} className="diff-removed">
                  − {part.value}
                </span>
              ) : (
                <span key={index}>{part.value}</span>
              ),
            )}
          </>
        ) : "text" in element ? (
          <InlineText text={element.text} />
        ) : null;
    switch (element.type) {
      case "heading": {
        const level = Math.max(1, Math.min(6, element.props.level));
        return wrap(<Heading level={level}>{text}</Heading>);
      }
      case "paragraph":
        return wrap(<p>{text}</p>);
      case "quote":
        return wrap(<blockquote>{text}</blockquote>);
      case "code_block":
        return wrap(
          <figure>
            <figcaption>{propsText(element, "language")}</figcaption>
            <pre>
              <code>{element.text}</code>
            </pre>
          </figure>,
        );
      case "list":
        return wrap(
          element.props.ordered ? <ol>{children(element.elementId)}</ol> : <ul>{children(element.elementId)}</ul>,
        );
      case "list_item":
        return (
          <li key={element.elementId} {...common} {...interact} className="doc-block">
            {gutter}
            {text}
            {children(element.elementId)}
          </li>
        );
      case "table":
        return wrap(
          <table>
            <tbody>{children(element.elementId)}</tbody>
          </table>,
        );
      case "table_row":
        // A <tr> may only contain cells, and each cell has its own comment affordance.
        return (
          <tr key={element.elementId} {...common} {...interact} className="doc-block">
            {children(element.elementId)}
          </tr>
        );
      case "table_cell":
        return (
          <td key={element.elementId} {...common} {...interact} className="doc-block">
            {gutter}
            {text}
          </td>
        );
      case "image":
        return wrap(
          <figure>
            <img
              src={window.vibecab?.blobUrl(element.blobHash) ?? `vc-blob://${element.blobHash}`}
              alt={element.props.alt ?? ""}
            />
            {element.props.caption ? <figcaption>{element.props.caption}</figcaption> : null}
          </figure>,
        );
      case "divider":
        return wrap(<hr />);
      case "callout":
        return wrap(
          <Alert
            tone={element.props.tone === "warning" ? "warning" : element.props.tone === "note" ? "success" : "info"}
          >
            {text}
          </Alert>,
        );
    }
  };
  const top = sorted.filter((element) => element.parentId === null),
    visible = top.slice(0, visibleCount),
    slotIsVisible = selectedTopId !== undefined && visible.some((element) => element.elementId === selectedTopId);
  return (
    <article className="document" aria-label={`Document version ${version}`} data-artifact-id={artifactId}>
      {visible.map((element) => {
        const slot = selectedTopId === element.elementId ? commentSlot : undefined,
          annotation = annotations?.[element.elementId];
        return (
          <Fragment key={element.elementId}>
            {renderElement(element)}
            {slot}
            {annotation}
          </Fragment>
        );
      })}
      {commentSlot && !slotIsVisible ? commentSlot : null}
      {top.length > visibleCount ? (
        <button onClick={() => setVisibleCount((count) => count + 100)}>
          Show next 100 blocks ({top.length - visibleCount} remaining)
        </button>
      ) : null}
    </article>
  );
}
function Heading({ level, children }: { level: number; children: ReactNode }) {
  const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return <Tag>{children}</Tag>;
}
