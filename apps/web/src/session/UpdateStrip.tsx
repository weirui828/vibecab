import { useEffect, useState } from "react";
import { Glider } from "../ui/Glider.js";
import { Button } from "@wei/design-system";
import { errorMessage } from "../../../ui/src/copy/errors.js";
import { terms } from "../../../ui/src/copy/terms.js";
import { useBridge } from "../live/LiveStore.js";
import { useToast } from "../ui/Toast.js";
import { newCommandId } from "../bridge/webBridge.js";
import { plural } from "../ui/time.js";
import type { Element } from "../../../../contract/generated/index.js";
import type { Agreement, Loop, Update } from "./loop.js";
import { startsIn, waitingAgreements } from "./loop.js";
import type { Thread } from "./threads.js";

const steps: Array<[Update["status"], string]> = [
  ["planning", "Plan"],
  ["writing", "Write"],
  ["checking", "Check"],
];

interface PlanItem {
  itemId: string;
  action?: string;
  elementIds?: string[];
  note?: string;
}
/** The planner's output is open JSON in the contract; read only the fields shown. */
export function planItems(plan: unknown): PlanItem[] {
  const items = typeof plan === "object" && plan !== null ? Reflect.get(plan, "items") : undefined;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return [];
    const get = (key: string) => Reflect.get(raw, key);
    const itemId = get("itemId"),
      action = get("action"),
      note = get("note"),
      elementIds = get("elementIds");
    if (typeof itemId !== "string") return [];
    return [
      {
        itemId,
        ...(typeof action === "string" ? { action } : {}),
        ...(typeof note === "string" ? { note } : {}),
        ...(Array.isArray(elementIds)
          ? { elementIds: elementIds.filter((id): id is string => typeof id === "string") }
          : {}),
      },
    ];
  });
}

const actionWords: Record<string, string> = {
  edit: "Edit",
  add: "Add",
  move: "Move",
  remove: "Remove",
  none: "Leave as is",
};

/** The comment an agreement came from, as a short quote, for lists. */
function agreedText(agreement: Agreement, threads: Thread[]): string {
  for (const thread of threads)
    for (const comment of thread.comments)
      if (comment.commentId === agreement.commentId)
        return agreement.kind === "option" && agreement.optionLabel
          ? `${agreement.optionLabel} — ${thread.comments[0]?.body ?? ""}`
          : comment.body;
  return "Agreed change";
}

export function UpdateStrip({
  artifactId,
  loop,
  threads,
  elements,
  dismissedUpdate,
  changesShown,
  onDismiss,
  onToggleChanges,
  onFind,
  onConflicts,
}: {
  artifactId: string;
  loop: Loop;
  threads: Thread[];
  elements: Element[];
  dismissedUpdate: string | undefined;
  changesShown: boolean;
  onDismiss(updateId: string): void;
  onToggleChanges(update: Update): void;
  onFind(elementId: string): void;
  onConflicts(): void;
}) {
  const bridge = useBridge(),
    toast = useToast(),
    [open, setOpen] = useState(false),
    [confirmCancel, setConfirmCancel] = useState(false),
    [openedAt] = useState(() => Date.now() - 2000),
    [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  const run = async (type: string, payload: unknown) => {
    const result = await bridge.command(type, payload, newCommandId());
    if (!result.ok) toast(errorMessage(result.error.code));
    return result.ok;
  };
  const waiting = waitingAgreements(loop),
    current = loop.current,
    latest = loop.latest,
    titles = new Map(elements.map((e) => [e.elementId, "text" in e ? e.text.slice(0, 48) : e.type]));

  // Conflicts come first: they block the Update until the person chooses.
  if (loop.conflicts.length > 0)
    return (
      <div className="vc-strip" data-tone="warning" role="region" aria-label="Conflicts">
        <span className="dot" aria-hidden="true" />
        <span className="text">
          <span className="lead">
            {loop.conflicts.length === 1 ? "Two agreed changes conflict" : `${loop.conflicts.length} conflicts`}
          </span>
          <span className="vc-facts">left out of the next {terms.update} until you choose</span>
        </span>
        <span className="actions">
          <Button size="sm" variant="secondary" onClick={onConflicts}>
            Choose
          </Button>
        </span>
      </div>
    );

  if (current) {
    const review = current.status === "awaiting_plan_review",
      at = steps.findIndex(([status]) => status === current.status);
    return (
      <div className="vc-strip" data-tone="agent" role="region" aria-label={terms.update}>
        <span className="dot pulse" aria-hidden="true" />
        <span className="text">
          <span className="lead">{review ? "The plan is ready for you" : `${terms.update} in progress`}</span>
          {!review && (
            <ol className="vc-steps-inline" aria-label="Progress">
              {steps.map(([status, label], index) => (
                <li key={status} data-state={index < at ? "done" : index === at ? "now" : "next"}>
                  {label}
                </li>
              ))}
            </ol>
          )}
        </span>
        <span className="actions">
          {confirmCancel ? (
            <>
              <span className="vc-facts">Stop this {terms.update}?</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>
                Continue
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  void run("vc.CancelUpdate", { updateId: current.updateId }).then(() => setConfirmCancel(false))
                }
              >
                Stop
              </Button>
            </>
          ) : (
            <>
              {review && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void run("vc.ApprovePlan", { updateId: current.updateId })}
                >
                  Approve plan
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>
                Cancel
              </Button>
            </>
          )}
        </span>
        {review && (
          <ul className="vc-plan">
            {planItems(current.plan).map((item) => {
              const agreement = loop.agreements.find((a) => a.agreementId === item.itemId);
              return (
                <li key={item.itemId}>
                  <span className="action">{actionWords[item.action ?? ""] ?? item.action ?? ""}</span>
                  <span className="what">{agreement ? agreedText(agreement, threads) : "Agreed change"}</span>
                  {item.note && <span className="note">{item.note}</span>}
                  {item.elementIds?.map((id) => (
                    <button key={id} type="button" className="vc-chip" onClick={() => onFind(id)}>
                      {titles.get(id) ?? "Block"}
                    </button>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  if (
    latest &&
    latest.updateId !== dismissedUpdate &&
    latest.status === "failed" &&
    Date.parse(latest.updatedAt ?? latest.createdAt) >= openedAt
  )
    return (
      <div className="vc-strip" data-tone="danger" role="region" aria-label={terms.update}>
        <span className="dot" aria-hidden="true" />
        <span className="text">
          <span className="lead">The {terms.update} did not go through</span>
          <span className="vc-facts">your agreed changes are still agreed</span>
        </span>
        <span className="actions">
          <Button size="sm" variant="ghost" onClick={() => onDismiss(latest.updateId)}>
            Dismiss
          </Button>
          <Button size="sm" variant="primary" onClick={() => void run("vc.StartUpdate", { artifactId })}>
            Try again
          </Button>
        </span>
      </div>
    );

  if (waiting.length > 0) {
    const when = startsIn(loop.scheduledAt);
    return (
      <div className="vc-strip" data-tone="agreed" role="region" aria-label="Agreed changes">
        <span className="dot" aria-hidden="true" />
        <span className="text">
          <span className="lead">{plural(waiting.length, "agreed change")}</span>
          {when && (
            <span className="vc-facts">
              {terms.update} starts {when}
            </span>
          )}
        </span>
        <span className="actions">
          <button type="button" className="vc-link-button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Show"}
          </button>
          <Button
            size="sm"
            variant="primary"
            disabled={!loop.modelReady}
            title={loop.modelReady ? undefined : "Add a model in Settings"}
            onClick={() => void run("vc.StartUpdate", { artifactId })}
          >
            {terms.update} now
          </Button>
        </span>
        {open && (
          <ul className="vc-plan">
            {waiting.map((a) => (
              <li key={a.agreementId}>
                <span className="what">{agreedText(a, threads)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  // A finished Update is news only if it finished while this page was open; older ones live in "Applied in…".
  const fresh = latest && Date.parse(latest.updatedAt ?? latest.createdAt) >= openedAt;
  if (
    latest &&
    fresh &&
    latest.updateId !== dismissedUpdate &&
    ["committed", "partially_committed"].includes(latest.status)
  ) {
    const applied = latest.itemResults.filter((r) => r.status === "addressed").length,
      missed = latest.itemResults.length - applied;
    return (
      <div className="vc-strip" data-tone="done" role="region" aria-label={terms.update}>
        <span className="dot" aria-hidden="true" />
        <span className="text">
          <span className="lead">Version {latest.resultVersion}</span>
          <span className="vc-facts">
            {plural(applied, "change")} applied{missed ? ` · ${missed} not applied` : ""}
            {latest.status === "partially_committed" ? " · the rest are agreed again" : ""}
          </span>
        </span>
        <span className="actions">
          <div className="vc-segmented small" role="group" aria-label="View">
            <Glider selector='[aria-pressed="true"],[aria-current="page"]' />
            <button type="button" aria-pressed={changesShown} onClick={() => !changesShown && onToggleChanges(latest)}>
              Show changes
            </button>
            <button type="button" aria-pressed={!changesShown} onClick={() => changesShown && onToggleChanges(latest)}>
              Hide changes
            </button>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onDismiss(latest.updateId)}>
            Dismiss
          </Button>
        </span>
      </div>
    );
  }

  return null;
}
