import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@wei/design-system";
import type { IconName } from "@wei/design-system";
import type { DiffResult, Element } from "../../../../contract/generated/index.js";
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

/** A changes view: the diff from the base version, and the base's removed top-level blocks to show in place. */
export interface DocDiff {
  result: DiffResult;
  removed: Element[];
}
const DiffContext = createContext<DiffResult | undefined>(undefined);

/**
 * Word-level changes inside one element. Insertions and deletions carry a "+" / "−" marker and words for screen
 * readers, so colour is never the only signal.
 */
function DiffText({ parts }: { parts: Array<{ value: string; added?: boolean; removed?: boolean }> }) {
  return (
    <span className="vc-text">
      {parts.map((part, index) =>
        part.added ? (
          <ins key={index} className="vc-ins">
            <span className="sr-only">added: </span>
            {part.value}
          </ins>
        ) : part.removed ? (
          <del key={index} className="vc-del">
            <span className="sr-only">removed: </span>
            {part.value}
          </del>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </span>
  );
}

/** The element's inline text, in the container that anchors and highlights count characters in. */
function Text({ id, text }: { id: string; text: string }) {
  const diff = useContext(DiffContext),
    parts = diff?.textDiffs[id];
  if (parts && diff?.changed.includes(id)) return <DiffText parts={parts} />;
  return (
    <span className="vc-text" data-text-for={id}>
      <InlineText text={text} />
    </span>
  );
}

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

const kindLabel: Partial<Record<Element["type"], string>> = {
  heading: "heading",
  paragraph: "paragraph",
  list: "list",
  quote: "quote",
  code_block: "code block",
  table: "table",
  image: "image",
  divider: "divider",
  callout: "callout",
};

export function DocumentView({
  elements,
  blobUrl,
  diff,
}: {
  elements: Element[];
  blobUrl(hash: string): string;
  diff?: DocDiff | undefined;
}) {
  const tree = useMemo(() => {
      const built = buildTree(elements);
      if (!diff) return built;
      // Removed blocks go back where they were: sibling order keys are stable across versions.
      const roots = [...built.roots, ...diff.removed.filter((e) => e.parentId === null)].sort((a, b) =>
        a.order < b.order ? -1 : a.order > b.order ? 1 : 0,
      );
      return { roots, children: built.children };
    }, [elements, diff]),
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
            <Text id={id} text={element.text} />
          </Heading>
        );
      case "paragraph":
        return (
          <p key={id} data-element-id={id}>
            <Text id={id} text={element.text} />
          </p>
        );
      case "quote":
        return (
          <blockquote key={id} data-element-id={id}>
            <Text id={id} text={element.text} />
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
            <Text id={id} text={element.text} />
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
                    <Text id={cell.elementId} text={cell.text} />
                  </th>
                ) : (
                  <td key={cell.elementId} data-element-id={cell.elementId}>
                    <Text id={cell.elementId} text={cell.text} />
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
              <Text id={id} text={element.text} />
            </div>
          </aside>
        );
    }
  }

  const removedIds = new Set(diff?.result.removed ?? []);
  function top(element: Element): ReactNode {
    const id = element.elementId;
    if (removedIds.has(id))
      return (
        <details key={id} className="vc-removed" data-element-id={id}>
          <summary>
            <span aria-hidden="true">−</span> Removed {kindLabel[element.type] ?? "block"}
          </summary>
          {"text" in element && element.type !== "code_block" ? <p>{element.text}</p> : null}
        </details>
      );
    const change = diff?.result.added.includes(id)
      ? "New"
      : diff?.result.moved.includes(id)
        ? "Moved"
        : diff?.result.changed.includes(id)
          ? "Changed"
          : undefined;
    if (!change) return block(element);
    return (
      <div key={id} className="vc-changed" data-change={change.toLowerCase()}>
        <span className="vc-change-label">{change}</span>
        {block(element)}
      </div>
    );
  }

  if (tree.roots.length === 0) return <p className="vc-doc-empty">Nothing written yet.</p>;
  return (
    <DiffContext.Provider value={diff?.result}>
      <article className="vc-doc" data-diff={diff ? "true" : undefined}>
        {tree.roots.slice(0, shown).map(top)}
        {more && <div ref={sentinel} className="vc-doc-more" aria-hidden="true" />}
      </article>
    </DiffContext.Provider>
  );
}
