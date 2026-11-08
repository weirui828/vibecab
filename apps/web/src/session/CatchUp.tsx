import { useEffect, useRef, useState } from "react";
import { Button } from "@wei/design-system";
import type { SessionDigest, VcResumeViewOperation } from "../../../../contract/generated/index.js";
import { terms } from "../../../ui/src/copy/terms.js";
import { plural } from "../ui/time.js";

type Resume = VcResumeViewOperation["result"];

export interface CatchUpLine {
  key: string;
  text: string;
  elementId?: string;
}

// Resume items are open objects in the contract; read only the fields shown, with their types checked.
const get = (item: unknown, key: string): unknown =>
  typeof item === "object" && item !== null && key in item ? Reflect.get(item, key) : undefined;
const str = (item: unknown, key: string) => {
  const value = get(item, key);
  return typeof value === "string" ? value : undefined;
};
const num = (item: unknown, key: string) => {
  const value = get(item, key);
  return typeof value === "number" ? value : undefined;
};
const author = (item: unknown) => str(get(item, "author"), "kind");
const anchorElement = (item: unknown) => str(get(item, "anchor"), "elementId");

/** Each item once, in reading order of importance. Exported for tests. */
export function catchUpLines(resume: Resume): CatchUpLine[] {
  const lines: CatchUpLine[] = [];
  for (const v of resume.versions) {
    const n = num(v, "version"),
      changes = num(v, "changeCount");
    lines.push({
      key: "v" + str(v, "artifactId") + n,
      text: `Version ${n ?? "?"}` + (changes !== undefined ? ` · ${plural(changes, "change")}` : ""),
    });
  }
  for (const r of resume.replies) {
    const elementId = anchorElement(r);
    lines.push({
      key: "r" + str(r, "commentId"),
      text: `${author(r) === "agent" ? "The agent" : "Someone"} replied: “${str(r, "body") ?? ""}”`,
      ...(elementId ? { elementId } : {}),
    });
  }
  for (const c of resume.comments) {
    if (author(c) === "system") continue;
    const elementId = anchorElement(c);
    lines.push({
      key: "c" + str(c, "commentId"),
      text: `${author(c) === "agent" ? "The agent" : "You"} commented: “${str(c, "body") ?? ""}”`,
      ...(elementId ? { elementId } : {}),
    });
  }
  if (resume.awaitingAgreement.length)
    lines.push({ key: "aw", text: `${plural(resume.awaitingAgreement.length, "item")} waiting for you to agree` });
  if (resume.conflicts.length)
    lines.push({ key: "cf", text: `${plural(resume.conflicts.length, "conflict")} to settle` });
  for (const u of resume.updates)
    lines.push({ key: "u" + str(u, "updateId"), text: `${terms.update}: ${str(u, "state") ?? "changed"}` });
  if (resume.lastOutputSet)
    lines.push({
      key: "os",
      text: `Last ${terms.snapshot.toLowerCase()}: ${resume.lastOutputSet.label ?? "unlabelled"}`,
    });
  return lines;
}

/** The one-line summary: "version 2 · 1 reply · 2 comments". */
export function catchUpSummary(resume: Resume): string {
  const parts: string[] = [];
  const latest = resume.versions.map((v) => num(v, "version") ?? 0).sort((a, b) => b - a)[0];
  if (latest) parts.push(`version ${latest}`);
  if (resume.replies.length) parts.push(plural(resume.replies.length, "reply"));
  const comments = resume.comments.filter((c) => author(c) !== "system").length;
  if (comments) parts.push(plural(comments, "comment"));
  if (resume.awaitingAgreement.length) parts.push(`${resume.awaitingAgreement.length} to agree`);
  if (resume.conflicts.length) parts.push(plural(resume.conflicts.length, "conflict"));
  if (resume.updates.length) parts.push(plural(resume.updates.length, terms.update.toLowerCase()));
  return parts.join(" · ");
}

export function CatchUp({
  resume,
  digest,
  onDismiss,
  onJump,
}: {
  resume: Resume;
  digest: SessionDigest | undefined;
  onDismiss(): void;
  onJump(elementId: string): void;
}) {
  const [open, setOpen] = useState(false),
    root = useRef<HTMLDivElement>(null);
  const lines = catchUpLines(resume),
    summary = catchUpSummary(resume);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => !root.current?.contains(event.target as Node) && setOpen(false);
    const key = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  if (!summary) return null;
  return (
    <div className="vc-catchup" ref={root} role="region" aria-label="Since you were here">
      <span className="dot" aria-hidden="true" />
      <span className="text">
        <span className="lead">Since you were here</span>
        <span className="vc-facts">{summary}</span>
      </span>
      <span className="actions">
        <button type="button" className="vc-link-button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Close
        </Button>
      </span>
      {open && (
        <div className="vc-catchup-panel">
          <ul>
            {lines.map((line) => (
              <li key={line.key}>
                {line.elementId ? (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onJump(line.elementId!);
                    }}
                  >
                    {line.text}
                  </button>
                ) : (
                  <span>{line.text}</span>
                )}
              </li>
            ))}
          </ul>
          {digest && (
            <div className="digest">
              <p className="vc-label">Where it stands · written by the agent</p>
              <p>{digest.whereItStands}</p>
              {digest.nextSteps.length > 0 && (
                <ul>
                  {digest.nextSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
