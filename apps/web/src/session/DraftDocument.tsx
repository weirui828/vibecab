import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Element, VcArtifactOperation } from "../../../../contract/generated/index.js";
import { Button } from "@wei/design-system";
import { terms } from "../../../ui/src/copy/terms.js";
import { useActions } from "../home/actions.js";
import { useBridge, useLiveQuery } from "../live/LiveStore.js";
import type { DraftRow, SessionRow } from "../live/workspace.js";
import { DocumentView } from "../document/DocumentView.js";
import { useToast } from "../ui/Toast.js";
import { CommentSurface } from "./CommentSurface.js";
import { ChangesView } from "./ChangesView.js";
import { ConflictDialog } from "./ConflictDialog.js";
import { UpdateStrip } from "./UpdateStrip.js";
import { ExportDialog } from "./ExportDialog.js";
import type { ExportTarget } from "./ExportDialog.js";
import { HistorySheet, SnapshotDialog } from "./HistorySheet.js";
import { VersionView } from "./VersionView.js";
import type { Loop, Update } from "./loop.js";
import type { Thread } from "./threads.js";
import { byElementId } from "./textRanges.js";

function flash(elementId: string) {
  const node = document.querySelector(byElementId(elementId));
  node?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  node?.classList.add("vc-flash");
  setTimeout(() => node?.classList.remove("vc-flash"), 1600);
}

/** One Draft in a session: the Update strip, then the Document with its margin threads, or its changes view. */
export function DraftDocument({
  session,
  artifactId,
  drafts,
  loop,
  skeleton,
}: {
  session: SessionRow;
  artifactId: string;
  /** The session's Drafts, for Snapshots and history. */
  drafts: DraftRow[];
  loop: Loop;
  skeleton: React.ReactNode;
}) {
  const bridge = useBridge(),
    toast = useToast(),
    actions = useActions(),
    elements = useLiveQuery<Element[]>("vc.Elements", { artifactId }),
    artifact = useLiveQuery<VcArtifactOperation["result"]>("vc.Artifact", { artifactId }),
    threads = useLiveQuery<Thread[]>("vc.Threads", { sessionId: session.sessionId }),
    [changes, setChanges] = useState<Update>(),
    [dismissed, setDismissed] = useState<string>(),
    [choosing, setChoosing] = useState(false),
    [viewing, setViewing] = useState<number>(),
    [history, setHistory] = useState(false),
    [snapshot, setSnapshot] = useState(false),
    [exporting, setExporting] = useState<{ target: ExportTarget; title: string }>(),
    seenVersion = useRef<number>(undefined),
    anchor = useRef<{ id: string; top: number }>(undefined);
  const readOnly = session.state === "ended" || !artifact.data;

  // Keep the block at the top of the viewport where it was when a new version re-renders the page.
  useEffect(() => {
    const record = () => {
      const header = document.querySelector(".vc-session-head")?.getBoundingClientRect().bottom ?? 0;
      for (const node of document.querySelectorAll<HTMLElement>(".vc-doc > [data-element-id]")) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom > header) {
          anchor.current = { id: node.dataset.elementId ?? "", top: rect.top };
          return;
        }
      }
    };
    record();
    window.addEventListener("scroll", record, { passive: true });
    return () => window.removeEventListener("scroll", record);
  }, []);
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (!saved) return;
    const node = document.querySelector<HTMLElement>(byElementId(saved.id));
    if (node) window.scrollBy(0, node.getBoundingClientRect().top - saved.top);
  }, [elements.data]);
  useEffect(() => {
    const version = artifact.data?.headVersion;
    if (version === undefined) return;
    if (seenVersion.current !== undefined && version > seenVersion.current) toast(`Version ${version} is ready`);
    seenVersion.current = version;
  }, [artifact.data?.headVersion, toast]);

  const openChanges = useCallback(
    (version: number) => {
      const update = loop.updates.find((u) => u.resultVersion === version);
      if (update) {
        setChanges(update);
        setDismissed(undefined);
        window.scrollTo?.({ top: 0, behavior: "smooth" });
      }
    },
    [loop.updates],
  );
  const closeChoosing = useCallback(() => setChoosing(false), []),
    closeHistory = useCallback(() => setHistory(false), []);
  const draft = drafts.find((d) => d.artifactId === artifactId);
  if (!elements.data) return <>{skeleton}</>;
  const allThreads = threads.data ?? [];
  return (
    <>
      {!viewing && (
        <UpdateStrip
          artifactId={artifactId}
          loop={loop}
          threads={allThreads}
          elements={elements.data}
          dismissedUpdate={dismissed}
          changesShown={changes !== undefined}
          onDismiss={(id) => {
            setDismissed(id);
            setChanges(undefined);
          }}
          onToggleChanges={(update) => setChanges((current) => (current ? undefined : update))}
          onFind={(id) => {
            setChanges(undefined);
            setTimeout(() => flash(id), 0);
          }}
          onConflicts={() => setChoosing(true)}
        />
      )}
      {session.state === "ended" && (
        <div className="vc-ended" role="note">
          <p>
            This {terms.session.toLowerCase()} has ended, so its threads stay as they were. To keep commenting, carry on
            in a new {terms.session.toLowerCase()} with the same {terms.draft.toLowerCase()}
            {drafts.length === 1 ? "" : "s"}.
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void actions.continueSession(session.title, drafts, artifactId)}
          >
            Continue in a new {terms.session.toLowerCase()}
          </Button>
        </div>
      )}
      {viewing && artifact.data && viewing < artifact.data.headVersion ? (
        <VersionView
          artifactId={artifactId}
          version={viewing}
          head={artifact.data.headVersion}
          readOnly={readOnly}
          onBack={() => setViewing(undefined)}
        />
      ) : changes ? (
        <ChangesView
          artifactId={artifactId}
          update={changes}
          elements={elements.data}
          loop={loop}
          threads={allThreads}
          blobUrl={bridge.blobUrl}
          onFind={flash}
        />
      ) : (
        <CommentSurface
          sessionId={session.sessionId}
          artifactId={artifactId}
          version={artifact.data?.headVersion ?? 1}
          elements={elements.data}
          readOnly={readOnly}
          loop={loop}
          replyMode={session.replyTrigger}
          onOpenChanges={openChanges}
          onHistory={() => setHistory(true)}
          onSnapshot={() => setSnapshot(true)}
        >
          <DocumentView elements={elements.data} blobUrl={bridge.blobUrl} />
        </CommentSurface>
      )}
      {history && draft && (
        <HistorySheet
          sessionId={session.sessionId}
          draft={draft}
          drafts={drafts}
          viewing={viewing}
          onView={(version) => {
            setChanges(undefined);
            setViewing(version);
          }}
          onExport={(target, title) => setExporting({ target, title })}
          onClose={closeHistory}
        />
      )}
      <SnapshotDialog
        open={snapshot}
        sessionId={session.sessionId}
        drafts={drafts}
        onClose={() => setSnapshot(false)}
      />
      <ExportDialog
        open={exporting !== undefined}
        target={exporting?.target}
        title={exporting?.title ?? ""}
        onClose={() => setExporting(undefined)}
      />
      <ConflictDialog open={choosing} loop={loop} threads={allThreads} onClose={closeChoosing} />
    </>
  );
}
