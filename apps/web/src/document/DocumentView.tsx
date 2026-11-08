import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@wei/design-system";
import type { IconName } from "@wei/design-system";
import type { Element } from "../../../../contract/generated/index.js";
import { InlineText } from "./InlineText.js";

const BATCH = 300;

export interface DocTree {
  roots: Element[];
  children: Map<string, Element[]>;
}

/** Builds the block tree: roots have `parentId: null`; siblings sort by their fractional `order`. */
export function buildTree(elements: Element[]): DocTree {
  const children = new Map<string, Element[]>(),
    roots: Element[] = [];
  const byOrder = (a: Element, b: Element) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
  for (const element of elements) {
    if (element.parentId === null) roots.push(element);
    else children.set(element.parentId, [...(children.get(element.parentId) ?? []), element]);
  }
  roots.sort(byOrder);
  for (const list of children.values()) list.sort(byOrder);
  return { roots, children };
}

const calloutIcon: Record<"info" | "note" | "warning", IconName> = {
  info: "information-circle",
  note: "pencil",
  warning: "exclamation-triangle",
};
const calloutLabel = { info: "Info", note: "Note", warning: "Warning" } as const;

function Heading({ level, id, children }: { level: number; id: string; children: ReactNode }) {
  const props = { "data-element-id": id, className: `vc-h vc-h${level}` };
  switch (level) {
    case 1:
      return <h1 {...props}>{children}</h1>;
    case 2:
      return <h2 {...props}>{children}</h2>;
    case 3:
      return <h3 {...props}>{children}</h3>;
    case 4:
      return <h4 {...props}>{children}</h4>;
    case 5:
      return <h5 {...props}>{children}</h5>;
    default:
      return <h6 {...props}>{children}</h6>;
  }
}

export function DocumentView({ elements, blobUrl }: { elements: Element[]; blobUrl(hash: string): string }) {
  const tree = useMemo(() => buildTree(elements), [elements]),
    [shown, setShown] = useState(BATCH),
    sentinel = useRef<HTMLDivElement>(null);
  const more = tree.roots.length > shown;
  useEffect(() => {
    const node = sentinel.current;
    if (!more || !node || typeof IntersectionObserver === "undefined") return;
    // Long Documents grow as the reader nears the end instead of rendering thousands of blocks at once.
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setShown((n) => n + BATCH),
      { rootMargin: "1200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more]);

  const kids = (element: Element) => (tree.children.get(element.elementId) ?? []).map(block);
  function block(element: Element): ReactNode {
    const id = element.elementId;
    switch (element.type) {
      case "heading":
        return (
          <Heading key={id} id={id} level={Math.max(1, Math.min(6, element.props.level))}>
            <InlineText text={element.text} />
          </Heading>
        );
      case "paragraph":
        return (
          <p key={id} data-element-id={id}>
            <InlineText text={element.text} />
          </p>
        );
      case "quote":
        return (
          <blockquote key={id} data-element-id={id}>
            <InlineText text={element.text} />
          </blockquote>
        );
      case "code_block":
        return (
          <figure key={id} data-element-id={id} className="vc-code">
            {element.props.language && <figcaption>{element.props.language}</figcaption>}
            <pre>
              <code>{element.text}</code>
            </pre>
          </figure>
        );
      case "list":
        return element.props.ordered ? (
          <ol key={id} data-element-id={id}>
            {kids(element)}
          </ol>
        ) : (
          <ul key={id} data-element-id={id}>
            {kids(element)}
          </ul>
        );
      case "list_item":
        return (
          <li key={id} data-element-id={id}>
            <InlineText text={element.text} />
            {kids(element)}
          </li>
        );
      case "table": {
        const rows = tree.children.get(id) ?? [],
          [first, ...rest] = rows;
        const row = (r: Element, header: boolean) => (
          <tr key={r.elementId} data-element-id={r.elementId}>
            {(tree.children.get(r.elementId) ?? []).map((cell) =>
              cell.type === "table_cell" ? (
                header ? (
                  <th key={cell.elementId} data-element-id={cell.elementId} scope="col">
                    <InlineText text={cell.text} />
                  </th>
                ) : (
                  <td key={cell.elementId} data-element-id={cell.elementId}>
                    <InlineText text={cell.text} />
                  </td>
                )
              ) : null,
            )}
          </tr>
        );
        return (
          <div key={id} data-element-id={id} className="vc-table">
            <table>
              {element.props.headerRow && first ? (
                <>
                  <thead>{row(first, true)}</thead>
                  <tbody>{rest.map((r) => row(r, false))}</tbody>
                </>
              ) : (
                <tbody>{rows.map((r) => row(r, false))}</tbody>
              )}
            </table>
          </div>
        );
      }
      case "table_row":
      case "table_cell":
        return null; // rendered by their table
      case "image":
        return (
          <figure key={id} data-element-id={id} className="vc-image">
            <img src={blobUrl(element.blobHash)} alt={element.props.alt ?? ""} loading="lazy" />
            {element.props.caption && <figcaption>{element.props.caption}</figcaption>}
          </figure>
        );
      case "divider":
        return <hr key={id} data-element-id={id} />;
      case "callout":
        return (
          <aside key={id} data-element-id={id} className="vc-callout" data-tone={element.props.tone}>
            <Icon name={calloutIcon[element.props.tone]} size={20} label={calloutLabel[element.props.tone]} />
            <div>
              <InlineText text={element.text} />
            </div>
          </aside>
        );
    }
  }

  if (tree.roots.length === 0) return <p className="vc-doc-empty">Nothing written yet.</p>;
  return (
    <article className="vc-doc">
      {tree.roots.slice(0, shown).map(block)}
      {more && <div ref={sentinel} className="vc-doc-more" aria-hidden="true" />}
    </article>
  );
}
