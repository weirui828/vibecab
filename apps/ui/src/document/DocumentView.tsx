import { useMemo, useState } from "react";
import type { Element } from "../../../../contract/generated/index.js";
import { Alert } from "@wei/design-system";
import type { ReactNode } from "react";
import { InlineText } from "./inline-markdown.js";

export function DocumentView({
  artifactId,
  version,
  elements,
  onComment,
}: {
  artifactId: string;
  version: number;
  elements: Element[];
  onComment: (element: Element, locator?: { quote: string; prefix: string; suffix: string }) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(400);
  const sorted = useMemo(() => [...elements].sort((a, b) => a.order.localeCompare(b.order)), [elements]);
  const children = (parentId: string) => sorted.filter((el) => el.parentId === parentId).map(renderElement);
  const propsText = (element: Element, key: string) =>
    key in element.props ? String(Reflect.get(element.props, key)) : "";
  const renderElement = (element: Element) => {
    const common = {
      key: element.elementId,
      "data-element-id": element.elementId,
      onDoubleClick: () => onComment(element),
    };
    const text = "text" in element ? <InlineText text={element.text} /> : null;
    switch (element.type) {
      case "heading": {
        const level = Math.max(1, Math.min(6, element.props.level));
        return (
          <div {...common} className="doc-block">
            <Heading level={level}>{text}</Heading>
          </div>
        );
      }
      case "paragraph":
        return (
          <p {...common} className="doc-block">
            {text}
          </p>
        );
      case "quote":
        return (
          <blockquote {...common} className="doc-block">
            {text}
          </blockquote>
        );
      case "code_block":
        return (
          <figure {...common} className="doc-block">
            <figcaption>{propsText(element, "language")}</figcaption>
            <pre>
              <code>{element.text}</code>
            </pre>
          </figure>
        );
      case "list":
        return element.props.ordered ? (
          <ol {...common} className="doc-block">
            {children(element.elementId)}
          </ol>
        ) : (
          <ul {...common} className="doc-block">
            {children(element.elementId)}
          </ul>
        );
      case "list_item":
        return (
          <li {...common} className="doc-block">
            {text}
            {children(element.elementId)}
          </li>
        );
      case "table":
        return (
          <table {...common} className="doc-block">
            <tbody>{children(element.elementId)}</tbody>
          </table>
        );
      case "table_row":
        return (
          <tr {...common} className="doc-block">
            {children(element.elementId)}
          </tr>
        );
      case "table_cell":
        return (
          <td {...common} className="doc-block">
            {text}
          </td>
        );
      case "image":
        return (
          <figure {...common} className="doc-block">
            <img
              src={window.vibecab?.blobUrl(element.blobHash) ?? `vc-blob://${element.blobHash}`}
              alt={element.props.alt ?? ""}
            />
            {element.props.caption ? <figcaption>{element.props.caption}</figcaption> : null}
          </figure>
        );
      case "divider":
        return <hr {...common} className="doc-block" />;
      case "callout":
        return (
          <div {...common} className="doc-block">
            <Alert
              tone={element.props.tone === "warning" ? "warning" : element.props.tone === "note" ? "success" : "info"}
            >
              {text}
            </Alert>
          </div>
        );
    }
  };
  const top = sorted.filter((el) => el.parentId === null),
    visible = top.slice(0, visibleCount);
  return (
    <article className="document" aria-label={`Document version ${version}`} data-artifact-id={artifactId}>
      {visible.map(renderElement)}
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
