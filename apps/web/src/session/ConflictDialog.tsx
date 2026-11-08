import { useEffect, useRef } from "react";
import { Button } from "@wei/design-system";
import { errorMessage } from "../../../ui/src/copy/errors.js";
import { terms } from "../../../ui/src/copy/terms.js";
import { useBridge } from "../live/LiveStore.js";
import { useToast } from "../ui/Toast.js";
import { newCommandId } from "../bridge/webBridge.js";
import type { FeedbackConflict, Loop } from "./loop.js";
import type { Thread } from "./threads.js";
import { anchorOf } from "./threads.js";

function judgeNote(conflict: FeedbackConflict): string | undefined {
  const judgement = conflict.judgement;
  if (!judgement || typeof judgement !== "object") return undefined;
  const verdict = Reflect.get(judgement, "verdict"),
    reason = Reflect.get(judgement, "reason");
  if (typeof verdict !== "string") return undefined;
  return `The agent thinks these are ${verdict.replace(/_/g, " ")}${typeof reason === "string" ? ": " + reason : "."}`;
}

/** Side by side, each agreed change with its words; the person keeps one. The judge's view is only information. */
export function ConflictDialog({
  open,
  loop,
  threads,
  onClose,
}: {
  open: boolean;
  loop: Loop;
  threads: Thread[];
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    bridge = useBridge(),
    toast = useToast();
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog?.open) dialog.close?.();
  }, [open]);
  const conflict = loop.conflicts[0];
  useEffect(() => {
    if (open && !conflict) onClose();
  }, [open, conflict, onClose]);
  if (!open || !conflict) return null;
  const item = (agreementId: string) => {
    const agreement = loop.agreements.find((a) => a.agreementId === agreementId),
      thread = threads.find((t) => t.comments.some((c) => c.commentId === agreement?.commentId)),
      comment = thread?.comments.find((c) => c.commentId === agreement?.commentId);
    return { agreement, thread, comment };
  };
  const keep = async (agreementId: string) => {
    const result = await bridge.command(
      "vc.ResolveConflict",
      { keep: agreementId, supersede: conflict.itemIds.filter((id) => id !== agreementId) },
      newCommandId(),
    );
    if (!result.ok) toast(errorMessage(result.error.code));
  };
  const note = judgeNote(conflict);
  return (
    <dialog
      ref={ref}
      className="vc-dialog vc-conflict"
      aria-labelledby="vc-conflict-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="inner">
        <h2 id="vc-conflict-title">Which one should the next {terms.update} follow?</h2>
        <p className="lede">
          These agreed changes pull the same text in different directions. Keep one; the other is set aside.
        </p>
        {note && <p className="vc-judge">{note}</p>}
        <div className="options">
          {conflict.itemIds.map((id) => {
            const { agreement, thread, comment } = item(id),
              quote = thread ? anchorOf(thread)?.locator?.quote : undefined;
            return (
              <section key={id} className="option">
                {quote && <blockquote className="quote">{quote}</blockquote>}
                <p className="body">
                  {agreement?.kind === "option" && agreement.optionLabel ? (
                    <strong>{agreement.optionLabel}: </strong>
                  ) : null}
                  {comment?.body ?? "Agreed change"}
                </p>
                <Button size="sm" variant="secondary" onClick={() => void keep(id)}>
                  Keep this one
                </Button>
              </section>
            );
          })}
        </div>
        <div className="buttons">
          <Button variant="ghost" onClick={onClose}>
            Decide later
          </Button>
        </div>
      </div>
    </dialog>
  );
}
