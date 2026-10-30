import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnchorResolution,
  DeliveryState,
  Element,
  Outline,
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
import { ResumeCard } from "./ResumeCard.js";
import { ThreadPanel } from "./ThreadPanel.js";
import { SessionWorkflow } from "./SessionWorkflow.js";

type Selected = { element: Element; locator?: { quote: string; prefix: string; suffix: string } };
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
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);
  const refresh = useCallback(async () => {
    if (!artifact) return;
    const outline = await window.vibecab.query<Outline>("vc.Outline", {
      artifactId: artifact.artifactId,
    });
    const list = await window.vibecab.query<Element[]>("vc.Elements", { artifactId: artifact.artifactId });
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
    setThreads(nextThreads);
    setTurns(await window.vibecab.query<AgentTurn[]>("vc.AgentTurns", { sessionId }));
    setResume(await window.vibecab.query<VcResumeViewOperation["result"]>("vc.ResumeView", { sessionId }));
    setDigest(await window.vibecab.query<VcDigestOperation["result"]>("vc.Digest", { sessionId }));
  }, [artifact, sessionId]);
  useEffect(() => {
    void refresh().catch(() => setMessage("Could not load this session."));
  }, [refresh]);
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
        void refresh();
    });
    const fallback = window.setInterval(() => void refresh(), 1_500);
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
  useEffect(() => {
    const ranges: Range[] = [],
      revised: Range[] = [];
    for (const thread of threads)
      for (const resolution of thread.anchorResolutions as AnchorResolution[]) {
        if (resolution.state === "removed") continue;
        const node = document.querySelector(`[data-element-id="${CSS.escape(resolution.anchor.elementId)}"]`);
        if (!node) continue;
        const range = document.createRange();
        if (resolution.state === "revised") {
          range.selectNodeContents(node);
          revised.push(range);
          continue;
        }
        const quote = resolution.anchor.locator?.quote;
        if (!quote) continue;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT),
          textNodes: Text[] = [];
        let current = walker.nextNode();
        while (current) {
          if (current instanceof Text) textNodes.push(current);
          current = walker.nextNode();
        }
        const fullText = textNodes.map((textNode) => textNode.data).join(""),
          start = fullText.indexOf(quote);
        if (start < 0) continue;
        let cursor = 0,
          startNode: Text | undefined,
          endNode: Text | undefined,
          startOffset = 0,
          endOffset = 0;
        for (const textNode of textNodes) {
          const next = cursor + textNode.data.length;
          if (!startNode && start >= cursor && start < next) {
            startNode = textNode;
            startOffset = start - cursor;
          }
          if (start + quote.length >= cursor && start + quote.length <= next) {
            endNode = textNode;
            endOffset = start + quote.length - cursor;
            break;
          }
          cursor = next;
        }
        if (startNode && endNode) {
          range.setStart(startNode, startOffset);
          range.setEnd(endNode, endOffset);
          ranges.push(range);
        }
      }
    if (typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined") {
      CSS.highlights.delete("vibecab-current");
      CSS.highlights.delete("vibecab-revised");
      if (ranges.length) CSS.highlights.set("vibecab-current", new Highlight(...ranges));
      if (revised.length) CSS.highlights.set("vibecab-revised", new Highlight(...revised));
    }
    return () => {
      if (typeof CSS !== "undefined" && "highlights" in CSS) {
        CSS.highlights.delete("vibecab-current");
        CSS.highlights.delete("vibecab-revised");
      }
    };
  }, [threads, elements]);
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
      <header className="session-header">
        <button onClick={onBack}>Home</button>
        <div>
          <p>
            {title} · {artifact?.title ?? "No Draft"}
          </p>
          <span>v{artifact?.headVersion ?? "—"}</span>
        </div>
        <span role="status">Connected</span>
        <button aria-label="Toggle threads" onClick={() => setShowThreads((open) => !open)}>
          Threads
        </button>
      </header>
      <div className="session-grid">
        <nav className="session-sidebar" aria-label="Session drafts">
          <h2>Drafts</h2>
          {artifacts.length ? (
            artifacts.map((item) => (
              <button
                key={item.artifactId}
                aria-current={item.artifactId === activeArtifactId}
                onClick={() => setActiveArtifactId(item.artifactId)}
              >
                {item.title}
              </button>
            ))
          ) : (
            <p>No Draft attached</p>
          )}
          <button onClick={() => void onAddDraft()}>Add new Draft</button>
          {availableArtifacts
            .filter((item) => !artifacts.some((attached) => attached.artifactId === item.artifactId))
            .map((item) => (
              <button
                key={item.artifactId}
                onClick={() =>
                  void window.vibecab
                    .command("vc.AttachArtifact", { sessionId, artifactId: item.artifactId, role: "supporting" })
                    .then((result) => {
                      if (result.ok) {
                        setArtifacts((current) => [...current, item]);
                        setActiveArtifactId(item.artifactId);
                      }
                    })
                }
              >
                Attach {item.title}
              </button>
            ))}
          <div className="session-controls">
            <button onClick={() => void window.vibecab.command("vc.PauseSession", { sessionId }).then(onRefresh)}>
              Pause
            </button>
            <button onClick={() => void window.vibecab.command("vc.ResumeSession", { sessionId }).then(onRefresh)}>
              Resume
            </button>
            <button onClick={() => void window.vibecab.command("vc.EndSession", { sessionId }).then(onRefresh)}>
              End
            </button>
          </div>
        </nav>
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
          ) : (
            <p>Attach a Draft to read its Document.</p>
          )}
          <button className="comment-toolbar" onClick={chooseRange}>
            Comment
          </button>
          <form
            className="comment-form"
            onSubmit={(event) => {
              event.preventDefault();
              void post();
            }}
          >
            <label>
              Comment
              <textarea aria-label="Comment" value={body} onChange={(event) => setBody(event.target.value)} />
            </label>
            {selected ? (
              <label>
                Suggest replacement
                <input
                  value={suggestion}
                  onChange={(event) => setSuggestion(event.target.value)}
                  placeholder={selected.locator?.quote ?? "Optional"}
                />
              </label>
            ) : null}
            <button type="submit">Post comment</button>
          </form>
          <p role="status">{message}</p>
          {updatedToast ? (
            <p className="update-toast" role="status">
              {updatedToast}
            </p>
          ) : null}
        </main>
        {showThreads ? (
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
