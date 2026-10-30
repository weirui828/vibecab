import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeliveryState,
  Element,
  Outline,
  DiffResult,
  VcResumeViewOperation,
  VcThreadsOperation,
  VcDigestOperation,
  VcSessionsOperation,
  VcUpdatesOperation,
  AgentTurn,
  Agreement,
  FeedbackConflict,
} from "../../../../contract/generated/index.js";
import { inlineMarkdownToPlainText } from "../../../../contract/src/inline-markdown.js";
import { locatorForTextSelection } from "../document/anchors.js";
import { DocumentView } from "../document/DocumentView.js";
import { ResumeCard } from "./ResumeCard.js";
import { ThreadPanel } from "./ThreadPanel.js";
import { SessionWorkflow } from "./SessionWorkflow.js";
import { SessionHeader, SessionSidebar } from "./SessionChrome.js";
import { useAnchorHighlights } from "./useAnchorHighlights.js";
import { CommentComposer } from "./CommentComposer.js";
import { DecisionRecordPanel } from "./DecisionRecordPanel.js";
import type { Selected } from "./types.js";

export function SessionView({
  sessionId,
  session,
  title,
  artifacts: initialArtifacts,
  availableArtifacts,
  onAddDraft,
  onBack,
  onRefresh,
}: {
  sessionId: string;
  session: VcSessionsOperation["result"][number];
  title: string;
  artifacts: { artifactId: string; title: string; headVersion: number }[];
  availableArtifacts: { artifactId: string; title: string; headVersion: number }[];
  onAddDraft: () => Promise<void>;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [artifacts, setArtifacts] = useState(initialArtifacts),
    [activeArtifactId, setActiveArtifactId] = useState(initialArtifacts[0]?.artifactId ?? "");
  useEffect(() => {
    setArtifacts((current) =>
      current.length === initialArtifacts.length &&
      current.every(
        (item, index) =>
          item.artifactId === initialArtifacts[index]?.artifactId &&
          item.headVersion === initialArtifacts[index]?.headVersion,
      )
        ? current
        : initialArtifacts,
    );
    if (!initialArtifacts.some((item) => item.artifactId === activeArtifactId))
      setActiveArtifactId(initialArtifacts[0]?.artifactId ?? "");
  }, [initialArtifacts, activeArtifactId]);
  const artifact = artifacts.find((item) => item.artifactId === activeArtifactId);
  const [elements, setElements] = useState<Element[]>([]),
    [viewingVersion, setViewingVersion] = useState<number>(),
    [snapshots, setSnapshots] = useState<import("../../../../contract/generated/index.js").OutputSet[]>([]),
    [showHistory, setShowHistory] = useState(false),
    [comparison, setComparison] = useState<DiffResult>(),
    [pendingExportId, setPendingExportId] = useState<string>(),
    [threads, setThreads] = useState<VcThreadsOperation["result"]>([]),
    [turns, setTurns] = useState<AgentTurn[]>([]),
    [nextUpdateCommentIds, setNextUpdateCommentIds] = useState<string[]>([]),
    [delivery, setDelivery] = useState<Record<string, DeliveryState["state"]>>({}),
    [resume, setResume] = useState<VcResumeViewOperation["result"]>(),
    [digest, setDigest] = useState<VcDigestOperation["result"]>([]),
    [selected, setSelected] = useState<Selected>(),
    [body, setBody] = useState(""),
    [suggestion, setSuggestion] = useState(""),
    [replyTo, setReplyTo] = useState(""),
    [showThreads, setShowThreads] = useState(true),
    [updatedToast, setUpdatedToast] = useState(""),
    [message, setMessage] = useState("");
  const onRefreshRef = useRef(onRefresh);
  const savedExports = useRef(new Set<string>());
  const [decisionRecord, setDecisionRecord] = useState<unknown[]>();
  useEffect(() => void (onRefreshRef.current = onRefresh), [onRefresh]);
  const refresh = useCallback(async () => {
    if (!artifact) return;
    const [latestArtifacts, outline] = await Promise.all([
      window.vibecab.query<import("../../../../contract/generated/index.js").VcArtifactsOperation["result"]>(
        "vc.Artifacts",
        {},
      ),
      window.vibecab.query<Outline>("vc.Outline", {
        artifactId: artifact.artifactId,
        ...(viewingVersion ? { version: viewingVersion } : {}),
      }),
    ]);
    const latestVersion = latestArtifacts.find((item) => item.artifactId === artifact.artifactId)?.headVersion;
    if (latestVersion && latestVersion > artifact.headVersion) {
      setArtifacts((current) =>
        current.map((item) =>
          item.artifactId === artifact.artifactId ? { ...item, headVersion: latestVersion } : item,
        ),
      );
      setUpdatedToast(`Updated to v${latestVersion}`);
    }
    const list = await window.vibecab.query<Element[]>("vc.Elements", {
      artifactId: artifact.artifactId,
      ...(viewingVersion ? { version: viewingVersion } : {}),
    });
    const nextThreads = await window.vibecab.query<VcThreadsOperation["result"]>("vc.Threads", {
      sessionId,
      artifactId: artifact.artifactId,
    });
    const [updates, agreements, conflicts] = await Promise.all([
      window.vibecab.query<VcUpdatesOperation["result"]>("vc.Updates", { artifactId: artifact.artifactId }),
      window.vibecab.query<Agreement[]>("vc.DecisionRecord", { artifactId: artifact.artifactId }),
      window.vibecab.query<FeedbackConflict[]>("vc.Conflicts", { sessionId, artifactId: artifact.artifactId }),
    ]);
    const activeUpdate = updates.updates.find((item) =>
        ["queued", "planning", "awaiting_plan_review", "writing", "checking"].includes(item.status),
      ),
      conflictIds = new Set(conflicts.filter((item) => item.state === "open").flatMap((item) => item.itemIds));
    setNextUpdateCommentIds(
      activeUpdate
        ? agreements
            .filter(
              (item) =>
                item.state === "agreed" &&
                !activeUpdate.itemIds.includes(item.agreementId) &&
                !conflictIds.has(item.agreementId),
            )
            .map((item) => item.commentId)
        : [],
    );
    const humanCommentIds = nextThreads.flatMap((thread) =>
      thread.comments.filter((comment) => comment.author.kind === "human").map((comment) => comment.commentId),
    );
    const states = humanCommentIds.length
      ? await window.vibecab.query<DeliveryState[]>("vc.DeliveryState", { commentIds: humanCommentIds })
      : [];
    setDelivery(Object.fromEntries(states.map((state) => [state.commentId, state.state])));
    const positions = new Map<string, number>();
    const visit = (nodes: Outline) =>
      nodes.forEach((node) => {
        positions.set(node.elementId, positions.size);
        visit(node.children);
      });
    visit(outline);
    const position = (thread: VcThreadsOperation["result"][number]) => {
      const anchor = thread.comments.find((comment) => comment.anchor)?.anchor;
      if (!anchor) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] as const;
      const resolution = thread.anchorResolutions.find((item) => item.anchor.elementId === anchor.elementId);
      if (resolution?.state === "removed") return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] as const;
      return [
        positions.get(anchor.elementId) ?? Number.MAX_SAFE_INTEGER - 1,
        resolution?.range?.start ?? Number.MAX_SAFE_INTEGER,
      ] as const;
    };
    nextThreads.sort((a, b) => {
      const left = position(a),
        right = position(b);
      return left[0] - right[0] || left[1] - right[1];
    });
    setElements(list);
    if (!viewingVersion) {
      const outputSets = await window.vibecab.query<import("../../../../contract/generated/index.js").OutputSet[]>(
        "vc.OutputSets",
        { sessionId },
      );
      setSnapshots(outputSets);
    }
    setThreads(nextThreads);
    setTurns(await window.vibecab.query<AgentTurn[]>("vc.AgentTurns", { sessionId }));
    setResume(await window.vibecab.query<VcResumeViewOperation["result"]>("vc.ResumeView", { sessionId }));
    setDigest(await window.vibecab.query<VcDigestOperation["result"]>("vc.Digest", { sessionId }));
  }, [artifact, sessionId, viewingVersion]);
  useEffect(() => {
    let active = true;
    void refresh().catch(() => {
      if (active) setMessage("Could not load this session.");
    });
    return () => {
      active = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!pendingExportId || savedExports.current.has(pendingExportId)) return;
    let cancelled = false;
    const waitForExport = async () => {
      for (let attempt = 0; attempt < 60 && !cancelled; attempt++) {
        const exports = await window.vibecab.query<
            Array<{ exportId: string; status: string; blobHash?: string; format: string }>
          >("vc.Exports", {}),
          item = exports.find((candidate) => candidate.exportId === pendingExportId);
        if (item?.status === "failed") throw new Error("Export failed.");
        if (item?.status === "completed" && item.blobHash) {
          savedExports.current.add(pendingExportId);
          const bytes = await window.vibecab.getBlob(item.blobHash),
            ext = item.format === "markdown" ? "md" : item.format;
          if (!cancelled) {
            await window.vibecab.app.saveFiles([{ name: `${artifact?.title ?? "VibeCab"}.${ext}`, bytes }]);
            setMessage("Export saved");
            setPendingExportId(undefined);
          }
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    };
    void waitForExport().catch((error: unknown) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : "Could not save export.");
    });
    return () => {
      cancelled = true;
    };
  }, [pendingExportId, artifact?.title]);
  useEffect(() => {
    const unsub = window.vibecab.subscribe(0, {}, (event) => {
      if (
        event.type === "vc.VersionCommitted" &&
        artifact &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        Reflect.get(event.payload, "artifactId") === artifact.artifactId
      ) {
        const version = Reflect.get(event.payload, "version");
        setUpdatedToast(typeof version === "number" ? `Updated to v${version}` : "Document updated");
        if (typeof version === "number")
          setArtifacts((current) =>
            current.map((item) => (item.artifactId === artifact.artifactId ? { ...item, headVersion: version } : item)),
          );
        setViewingVersion(undefined);
        const topId = document.elementFromPoint(220, 100)?.closest<HTMLElement>("[data-element-id]")?.dataset.elementId;
        onRefreshRef.current();
        window.requestAnimationFrame(() => {
          if (topId)
            document.querySelector(`[data-element-id="${CSS.escape(topId)}"]`)?.scrollIntoView({ block: "start" });
        });
      }
      if (
        [
          "vc.VersionCommitted",
          "vc.CommentPosted",
          "vc.CommentEdited",
          "vc.CommentDeleted",
          "vc.DeliveryStateChanged",
          "vc.AgentTurnChanged",
        ].includes(event.type)
      )
        void refresh().catch(() => undefined);
      if (
        event.type === "vc.LifecycleChanged" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        Reflect.get(event.payload, "kind") === "export" &&
        Reflect.get(event.payload, "action") === "completed"
      ) {
        const exportId = Reflect.get(event.payload, "id");
        if (typeof exportId === "string") setPendingExportId(exportId);
      }
    });
    const fallback = window.setInterval(() => void refresh().catch(() => undefined), 1_500);
    return () => {
      unsub();
      window.clearInterval(fallback);
    };
  }, [artifact, refresh]);
  useEffect(() => {
    let timer: number | undefined;
    const mark = () => {
      if (document.hasFocus())
        timer = window.setTimeout(() => {
          void window.vibecab.command("vc.MarkSeen", { sessionId });
        }, 3000);
    };
    const focus = () => mark(),
      blur = () => {
        if (timer) window.clearTimeout(timer);
      };
    mark();
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, [sessionId]);
  useAnchorHighlights(threads);
  const chooseRange = () => {
    const selection = window.getSelection(),
      selectionRange = selection?.rangeCount ? selection.getRangeAt(0) : undefined,
      textNode = selectionRange?.startContainer,
      el = textNode instanceof globalThis.Element ? textNode : textNode?.parentElement?.closest("[data-element-id]");
    if (!selection || !selectionRange || !el) return;
    const element = elements.find((candidate) => candidate.elementId === el.getAttribute("data-element-id"));
    if (!element || !("text" in element)) return;
    const contents = document.createRange();
    contents.selectNodeContents(el);
    const clipped = selectionRange.cloneRange();
    if (clipped.compareBoundaryPoints(Range.END_TO_END, contents) > 0)
      clipped.setEnd(contents.endContainer, contents.endOffset);
    const startRange = document.createRange();
    startRange.selectNodeContents(el);
    startRange.setEnd(clipped.startContainer, clipped.startOffset);
    const start = inlineMarkdownToPlainText(startRange.toString()).length,
      quote = clipped.toString();
    if (!quote) return;
    const boundedStart = start;
    setSelected({
      element,
      locator: locatorForTextSelection(
        element.text,
        boundedStart < 0 ? 0 : boundedStart,
        (boundedStart < 0 ? 0 : boundedStart) + quote.length,
      ),
    });
  };
  const post = async () => {
    if (!body.trim()) return;
    const payload: Record<string, unknown> = { sessionId, body: body.trim() };
    if (replyTo) payload.replyTo = replyTo;
    else if (selected && artifact)
      payload.anchor = {
        artifactId: artifact.artifactId,
        elementId: selected.element.elementId,
        seenVersion: artifact.headVersion,
        ...(selected.locator ? { locator: selected.locator } : {}),
      };
    if (suggestion) payload.suggestion = { replacement: suggestion };
    setMessage("Sending comment…");
    try {
      const result = await window.vibecab.command("vc.Comment", payload);
      if (!result.ok) throw new Error(result.error.message);
      setBody("");
      setSuggestion("");
      setReplyTo("");
      setSelected(undefined);
      setMessage("Comment posted");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not post comment.");
    }
  };
  return (
    <section className="session-view">
      <SessionHeader
        title={title}
        artifact={artifact}
        artifacts={artifacts}
        sessionId={sessionId}
        snapshots={snapshots}
        showHistory={showHistory}
        setShowHistory={setShowHistory}
        setViewingVersion={setViewingVersion}
        setActiveArtifactId={setActiveArtifactId}
        setComparison={setComparison}
        refresh={refresh}
        setPendingExportId={setPendingExportId}
        setShowThreads={setShowThreads}
        onBack={onBack}
      />
      <div className="session-grid">
        <SessionSidebar
          artifacts={artifacts}
          activeArtifactId={activeArtifactId}
          setActiveArtifactId={setActiveArtifactId}
          availableArtifacts={availableArtifacts}
          sessionId={sessionId}
          setArtifacts={setArtifacts}
          onAddDraft={onAddDraft}
          onRefresh={onRefresh}
        />
        <main
          className="document-region"
          onMouseUp={chooseRange}
          onKeyDown={(event) => {
            if (event.metaKey && event.altKey && event.key.toLowerCase() === "m") {
              event.preventDefault();
              chooseRange();
              window.setTimeout(
                () => document.querySelector<HTMLTextAreaElement>(".comment-form textarea")?.focus(),
                0,
              );
            } else if (event.metaKey && event.key === "Enter") {
              event.preventDefault();
              void post();
            }
          }}
        >
          {viewingVersion ? (
            <p role="status">
              Viewing v{viewingVersion} — read only{" "}
              <button
                onClick={() => {
                  setViewingVersion(undefined);
                  setComparison(undefined);
                }}
              >
                Back to latest
              </button>
            </p>
          ) : null}
          {resume ? (
            <ResumeCard
              resume={resume}
              digest={digest[0]}
              onGotIt={() => {
                void window.vibecab.command("vc.MarkSeen", { sessionId });
                setResume(undefined);
              }}
            />
          ) : null}
          {artifact ? (
            viewingVersion ? (
              <DocumentView
                artifactId={artifact.artifactId}
                version={viewingVersion}
                elements={elements}
                onComment={() => undefined}
                diff={comparison}
                showChanges={Boolean(comparison)}
              />
            ) : (
              <>
                <SessionWorkflow
                  sessionId={sessionId}
                  session={session}
                  artifact={artifact}
                  threads={threads}
                  currentElements={elements}
                  onRefresh={refresh}
                  onFocusElement={(elementId) =>
                    document
                      .querySelector(`[data-element-id="${CSS.escape(elementId)}"]`)
                      ?.scrollIntoView({ block: "center" })
                  }
                  onComment={(element, locator) => setSelected({ element, ...(locator ? { locator } : {}) })}
                />
              </>
            )
          ) : (
            <p>Attach a Draft to read its Document.</p>
          )}
          {artifact && !viewingVersion ? (
            <button
              onClick={() =>
                void window.vibecab
                  .query<unknown[]>("vc.DecisionRecord", { artifactId: artifact.artifactId })
                  .then(setDecisionRecord)
              }
            >
              Why is this here?
            </button>
          ) : null}
          {decisionRecord ? <DecisionRecordPanel items={decisionRecord} /> : null}
          {!viewingVersion ? (
            <CommentComposer
              body={body}
              setBody={setBody}
              selected={selected}
              suggestion={suggestion}
              setSuggestion={setSuggestion}
              onSubmit={() => void post()}
              onChooseRange={chooseRange}
            />
          ) : null}
          <p role="status">{message}</p>
          {updatedToast ? (
            <p className="update-toast" role="status">
              {updatedToast}
            </p>
          ) : null}
        </main>
        {showThreads && !viewingVersion ? (
          <ThreadPanel
            threads={threads}
            turns={turns}
            nextUpdateCommentIds={nextUpdateCommentIds}
            delivery={delivery}
            currentVersion={artifact?.headVersion ?? 0}
            onRefresh={refresh}
            onReply={(commentId) => {
              setReplyTo(commentId);
              setSelected(undefined);
            }}
            onAskAgent={(threadId) =>
              void window.vibecab.command("vc.AskAgent", { sessionId, threadIds: [threadId] }).then(refresh)
            }
            onSetThreadTrigger={(threadId, mode) =>
              void window.vibecab.command("vc.SetReplyTrigger", { sessionId, threadId, mode }).then(refresh)
            }
          />
        ) : null}
      </div>
    </section>
  );
}
