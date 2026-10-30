import type { DiffResult, Element } from "../../../../contract/generated/index.js";

export function UpdateDiff({
  diff,
  baseElements,
  currentElements,
  showChanges,
  onFocusElement,
}: {
  diff: DiffResult;
  baseElements: Element[];
  currentElements: Element[];
  showChanges: boolean;
  onFocusElement: (elementId: string) => void;
}) {
  const currentById = new Map(currentElements.map((element) => [element.elementId, element]));
  const baseById = new Map(baseElements.map((element) => [element.elementId, element]));
  return (
    <div className="update-diff" aria-label="Document changes">
      {diff.added.map((id) => (
        <button key={id} type="button" data-change="added" onClick={() => onFocusElement(id)}>
          + Added {elementLabel(currentById.get(id))}
        </button>
      ))}
      {diff.removed.map((id) => (
        <details key={id} data-change="removed">
          <summary>− Removed {elementLabel(baseById.get(id))}</summary>
          <p>{elementText(baseById.get(id))}</p>
        </details>
      ))}
      {diff.moved.map((id) => (
        <button key={id} type="button" data-change="moved" onClick={() => onFocusElement(id)}>
          ↕ Moved {elementLabel(currentById.get(id))}
        </button>
      ))}
      {showChanges
        ? diff.changed.map((id) => (
            <div key={id} data-change="changed">
              <button type="button" onClick={() => onFocusElement(id)}>
                Changed {elementLabel(currentById.get(id))}
              </button>
              <p>
                {diff.textDiffs[id]?.map((part, index) =>
                  part.added ? (
                    <span className="diff-added" key={index}>
                      + {part.value}
                    </span>
                  ) : part.removed ? (
                    <span className="diff-removed" key={index}>
                      − {part.value}
                    </span>
                  ) : (
                    <span key={index}>{part.value}</span>
                  ),
                ) ?? <span>Content changed.</span>}
              </p>
            </div>
          ))
        : null}
    </div>
  );
}

function elementLabel(element: Element | undefined): string {
  return element ? `${element.type.replaceAll("_", " ")}` : "block";
}

function elementText(element: Element | undefined): string {
  return element && "text" in element ? element.text : "This block was removed.";
}
