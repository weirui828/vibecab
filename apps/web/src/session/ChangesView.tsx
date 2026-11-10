import { useMemo } from "react";
import type { DiffResult, Element } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";
import { useLiveQuery } from "../live/LiveStore.js";
import { DocumentView } from "../document/DocumentView.js";
import type { Loop, Update } from "./loop.js";
import type { Thread } from "./threads.js";

/**
 * The Document from an Update's base to its result, read-only: word diffs, new / moved / changed blocks and removed
 * blocks in place. Above it, what happened to each agreed change.
 */
export function ChangesView({
  artifactId,
  update,
  elements,
  loop,
  threads,
  blobUrl,
  onFind,
}: {
  artifactId: string;
  update: Update;
  elements: Element[];
  loop: Loop;
  threads: Thread[];
  blobUrl(hash: string): string;
  onFind(elementId: string): void;
}) {
  const to = update.resultVersion ?? update.baseVersion,
    diff = useLiveQuery<DiffResult>("vc.Diff", { artifactId, from: update.baseVersion, to }),
    base = useLiveQuery<Element[]>("vc.Elements", { artifactId, version: update.baseVersion }),
    result = useLiveQuery<Element[]>("vc.Elements", { artifactId, version: to });
  const docDiff = useMemo(
    () =>
      diff.data && base.data
        ? { result: diff.data, removed: base.data.filter((e) => diff.data!.removed.includes(e.elementId)) }
        : undefined,
    [diff.data, base.data],
  );
  const shown = result.data ?? elements;
  const bodyOf = (agreementId: string) => {
    const agreement = loop.agreements.find((a) => a.agreementId === agreementId);
    for (const thread of threads)
      for (const comment of thread.comments)
        if (comment.commentId === agreement?.commentId)
          return agreement.kind === "option" && agreement.optionLabel
            ? `${agreement.optionLabel} — ${thread.comments[0]?.body ?? ""}`
            : comment.body;
    return "Agreed change";
  };
  const titles = new Map(shown.map((e) => [e.elementId, "text" in e ? e.text.slice(0, 40) : e.type]));
  return (
    <div className="vc-changes">
      <section className="vc-results" aria-label={`What this ${terms.update} did`}>
        <p className="vc-facts">
          Version {update.baseVersion} → {to} · written by the agent for you
        </p>
        <ul>
          {update.itemResults.map((item) => (
            <li key={item.itemId} data-status={item.status}>
              <span className="mark" aria-hidden="true">
                {item.status === "addressed" ? "✓" : "–"}
              </span>
              <span className="what">
                <span className="body">{bodyOf(item.itemId)}</span>
                <span className="vc-facts">
                  {item.status === "addressed" ? terms.applied : `Not applied${item.reason ? ": " + item.reason : ""}`}
                </span>
                {item.elementIds?.map((id) => (
                  <button key={id} type="button" className="vc-chip" onClick={() => onFind(id)}>
                    {titles.get(id) ?? "Block"}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {docDiff ? <DocumentView elements={shown} blobUrl={blobUrl} diff={docDiff} /> : null}
    </div>
  );
}
