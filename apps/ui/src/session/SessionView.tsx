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
import { DocumentView } from "../document/DocumentView.js";
import { ResumeCard } from "./ResumeCard.js";
import { ThreadCard, ThreadPanel } from "./ThreadPanel.js";
import { groupInlineThreads } from "./inlineThreads.js";
import { SessionWorkflow } from "./SessionWorkflow.js";
import { SessionHeader, SessionSidebar } from "./SessionChrome.js";
import { useAnchorHighlights } from "./useAnchorHighlights.js";
import { SessionPanelLayout } from "./SessionPanelLayout.js";
import { useExportSaver } from "./useExportSaver.js";
import { CommentComposer } from "./CommentComposer.js";
import { CommentDock } from "./CommentDock.js";
import { DecisionRecordPanel } from "./DecisionRecordPanel.js";
import { useCommentSelection } from "./selection.js";
import { useSessionSync } from "./useSessionSync.js";
import { getSessionHeaderMeta } from "./headerMeta.js";

export function SessionView({
  sessionId,
  session,
  title,
  artifacts: initialArtifacts,
  availableArtifacts,
  onAddDraft,
  onBack,
  onRefresh,
  onCreateProject,
}: {
  sessionId: string;
  session: VcSessionsOperation["result"][number];
  title: string;
  artifacts: { artifactId: string; title: string; headVersion: number }[];
  availableArtifacts: { artifactId: string; title: string; headVersion: number }[];
  onAddDraft: () => Promise<void>;
  onBack: () => void;
  onRefresh: () => void;
  onCreateProject?: () => void;
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
    [body, setBody] = useState(""),
    [suggestion, setSuggestion] = useState(""),
    [replyTo, setReplyTo] = useState(""),
    [showThreads, setShowThreads] = useState(true),
    [updatedToast, setUpdatedToast] = useState(""),
    [message, setMessage] = useState("");
  const [decisionRecord, setDecisionRecord] = useState<unknown[]>();
  const threadsVisible = showThreads && !viewingVersion;
  const canComment = session.state === "active";
  const readOnly = session.state === "ended";
  const refreshNow = useCallback(async () => {
    if (!artifact) return;
    const versionArgs = viewingVersion ? { version: viewingVersion } : {};
    // Load the Document first so it paints immediately; everything else follows in parallel.
    const [outline, list] = await Promise.all([
      window.vibecab.query<Outline>("vc.Outline", { artifactId: artifact.artifactId, ...versionArgs }),
      window.vibecab.query<Element[]>("vc.Elements", { artifactId: artifact.artifactId, ...versionArgs }),
    ]);
    setElements(list);
    const [latestArtifacts, nextThreads, updates, agreements, conflicts] = await Promise.all([
      window.vibecab.query<import("../../../../contract/generated/index.js").VcArtifactsOperation["result"]>(
        "vc.Artifacts",
        {},
      ),
      window.vibecab.query<VcThreadsOperation["result"]>("vc.Threads", {
        sessionId,
        artifactId: artifact.artifactId,
      }),
      window.vibecab.query<VcUpdatesOperation["result"]>("vc.Updates", { artifactId: artifact.artifactId }),
      window.vibecab.query<Agreement[]>("vc.DecisionRecord", { artifactId: artifact.artifactId }),
      window.vibecab.query<FeedbackConflict[]>("vc.Conflicts", { sessionId, artifactId: artifact.artifactId }),
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
    const [outputSets, nextTurns, nextResume, nextDigest] = await Promise.all([
      viewingVersion
        ? Promise.resolve(undefined)
        : window.vibecab.query<import("../../../../contract/generated/index.js").OutputSet[]>("vc.OutputSets", {
            sessionId,
          }),
      window.vibecab.query<AgentTurn[]>("vc.AgentTurns", { sessionId }),
      window.vibecab.query<VcResumeViewOperation["result"]>("vc.ResumeView", { sessionId }),
      window.vibecab.query<VcDigestOperation["result"]>("vc.Digest", { sessionId }),
    ]);
    if (outputSets) setSnapshots(outputSets);
    setThreads(nextThreads);
    setTurns(nextTurns);
    setResume(nextResume);
    setDigest(nextDigest);
    // Deliberately keyed on primitives: a new `artifact` object identity must not restart the
    // refresh chain on every render.
  }, [artifact?.artifactId, artifact?.headVersion, sessionId, viewingVersion]);
  // Polls, live events and user actions ask for refreshes concurrently. Run them one at a time and
  // queue at most one follow-up, so a result can never be applied out of order and a refresh
  // requested while another was in flight still sees the latest state.
  const running = useRef<Promise<void> | undefined>(undefined),
    queued = useRef(false);
  const refresh = useCallback(() => {
    if (running.current) {
      queued.current = true;
      return running.current;
    }
    running.current = (async () => {
      do {
        queued.current = false;
        await refreshNow();
      } while (queued.current);
    })().finally(() => {
      running.current = undefined;
    });
    return running.current;
  }, [refreshNow]);
  useEffect(() => {
    let active = true;
    void refresh().catch(() => {
      if (active) setMessage("Could not load this session.");
    });
    return () => {
      active = false;
    };
  }, [refresh]);
  useExportSaver(pendingExportId, setPendingExportId, artifact?.title, setMessage);
  useSessionSync({
    artifact,
    sessionId,
    refresh,
    onRefresh,
    setArtifacts,
    setViewingVersion,
    setUpdatedToast,
    setPendingExportId,
  });
  useAnchorHighlights(threads);
  const { selected, float, setSelected, chooseRange, clearSelection, dismissFloat } = useCommentSelection(
    elements,
    () => setSuggestion(""),
    () => setReplyTo(""),
  );
  const post = async () => {
    if (!body.trim() || !canComment) return;
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
      setReplyTo("");
      clearSelection();
      setMessage("Comment posted");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not post comment.");
    }
  };
  // Inline composer: rendered by DocumentView directly under the piece being commented on.
  const commentSlot =
    selected && canComment ? (
      <div className="doc-comment-slot">
        <CommentComposer
          body={body}
          setBody={setBody}
          selected={selected}
          suggestion={suggestion}
          setSuggestion={setSuggestion}
          onSubmit={() => void post()}
          onCancel={clearSelection}
          autoFocus={selected.source === "block"}
        />
      </div>
    ) : undefined;
  const renderReply = (commentId: string) =>
    canComment && replyTo === commentId ? (
      <div className="inline-reply">
        <CommentComposer
          body={body}
          setBody={setBody}
          suggestion={suggestion}
          setSuggestion={setSuggestion}
          onSubmit={() => void post()}
          onCancel={() => setReplyTo("")}
          autoFocus
        />
      </div>
    ) : undefined;
  const card = (thread: import("./inlineThreads.js").Thread, inline: boolean) => (
    <ThreadCard
      key={thread.threadId}
      thread={thread}
      turns={turns}
      nextUpdateCommentIds={nextUpdateCommentIds}
      delivery={delivery}
      currentVersion={artifact?.headVersion ?? 0}
      onRefresh={refresh}
      onReply={(commentId) => {
        clearSelection();
        setReplyTo(commentId);
      }}
      onAskAgent={(threadId) =>
        void window.vibecab.command("vc.AskAgent", { sessionId, threadIds: [threadId] }).then(refresh)
      }
      onSetThreadTrigger={(threadId, mode) =>
        void window.vibecab.command("vc.SetReplyTrigger", { sessionId, threadId, mode }).then(refresh)
      }
      renderReply={renderReply}
      canReply={canComment}
      readOnly={readOnly}
      inline={inline}
    />
  );
  const { annotations } = groupInlineThreads(threads, elements, (thread) => card(thread, true));
  const wholeSessionComposer =
    canComment && !selected && !replyTo ? (
      <CommentComposer
        body={body}
        setBody={setBody}
        suggestion={suggestion}
        setSuggestion={setSuggestion}
        onSubmit={() => void post()}
      />
    ) : undefined;
  const headerMeta = getSessionHeaderMeta(session, elements, threads, delivery);
  return (
    <section className="session-view">
      <SessionHeader
        meta={headerMeta}
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
        onCreateProject={onCreateProject}
      />
      <SessionPanelLayout threadsVisible={threadsVisible}>
        <SessionSidebar
          artifacts={artifacts}
          sessionState={session.state}
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
                () =>
                  document
                    .querySelector<HTMLTextAreaElement>(".doc-comment-slot textarea, .comment-form textarea")
                    ?.focus(),
                0,
              );
            } else if (event.metaKey && event.key === "Enter") {
              event.preventDefault();
              void post();
            }
          }}
        >
          {viewingVersion ? (
            <p role="status" className="viewing-banner">
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
                commentable={false}
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
                  onComment={(element, locator) => {
                    dismissFloat();
                    setSelected({ element, ...(locator ? { locator } : {}), source: locator ? "range" : "block" });
                  }}
                  selectedElementId={selected?.element.elementId}
                  commentSlot={commentSlot}
                  annotations={annotations}
                  commentable={canComment}
                />
              </>
            )
          ) : (
            <p>Attach a Draft to read its Document.</p>
          )}
          {artifact && !viewingVersion ? (
            <button
              className="quiet-link why-here"
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
            <CommentDock
              selected={selected}
              float={float}
              composer={wholeSessionComposer}
              onFloatClick={dismissFloat}
            />
          ) : null}
          <p role="status" className="composer-status">
            {message}
          </p>
          {updatedToast ? (
            <p className="update-toast" role="status">
              {updatedToast}
            </p>
          ) : null}
        </main>
        {threadsVisible ? (
          <ThreadPanel
            threads={threads}
            turns={turns}
            nextUpdateCommentIds={nextUpdateCommentIds}
            delivery={delivery}
            currentVersion={artifact?.headVersion ?? 0}
            onRefresh={refresh}
            onReply={(commentId) => {
              setReplyTo(commentId);
              clearSelection();
            }}
            onAskAgent={(threadId) =>
              void window.vibecab.command("vc.AskAgent", { sessionId, threadIds: [threadId] }).then(refresh)
            }
            onSetThreadTrigger={(threadId, mode) =>
              void window.vibecab.command("vc.SetReplyTrigger", { sessionId, threadId, mode }).then(refresh)
            }
            renderReply={renderReply}
            canReply={canComment}
            readOnly={readOnly}
          />
        ) : null}
      </SessionPanelLayout>
    </section>
  );
}
