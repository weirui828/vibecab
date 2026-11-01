import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  AgentTurn,
  Agreement,
  Element,
  FeedbackConflict,
  Grant,
  Settings,
  Update,
  UpdatePlan,
  VcSessionsOperation,
  VcUpdatesOperation,
} from "../../../../contract/generated/index.js";
import type { DiffResult } from "../../../../contract/generated/index.js";
import type { VcThreadsOperation } from "../../../../contract/generated/index.js";
import { DocumentView } from "../document/DocumentView.js";
import { UpdateDiff } from "./UpdateDiff.js";
import { coalesce } from "../coalesce.js";

type Session = VcSessionsOperation["result"][number];
type PlanItem = UpdatePlan["items"][number];

export function SessionWorkflow({
  sessionId,
  session,
  artifact,
  threads,
  currentElements,
  onRefresh,
  onFocusElement,
  onComment,
  selectedElementId,
  commentSlot,
  commentable = true,
}: {
  sessionId: string;
  session: Session;
  artifact: { artifactId: string; title: string; headVersion: number };
  threads: VcThreadsOperation["result"];
  currentElements: Element[];
  onRefresh: () => Promise<void>;
  onFocusElement: (elementId: string) => void;
  onComment: (element: Element, locator?: { quote: string; prefix: string; suffix: string }) => void;
  selectedElementId?: string;
  commentSlot?: ReactNode;
  commentable?: boolean;
}) {
  const [queryResult, setQueryResult] = useState<VcUpdatesOperation["result"]>({ updates: [] }),
    [conflicts, setConflicts] = useState<FeedbackConflict[]>([]),
    [turns, setTurns] = useState<AgentTurn[]>([]),
    [agreements, setAgreements] = useState<Agreement[]>([]),
    [settings, setSettings] = useState<Settings>(),
    [grants, setGrants] = useState<Grant[]>([]),
    [detail, setDetail] = useState<Update>(),
    [writtenByAgent, setWrittenByAgent] = useState(false),
    [diff, setDiff] = useState<DiffResult>(),
    [baseElements, setBaseElements] = useState<Element[]>([]),
    [message, setMessage] = useState(""),
    [showChanges, setShowChanges] = useState(true),
    [batchCount, setBatchCount] = useState(3),
    [idleMinutes, setIdleMinutes] = useState(2);
  const refresh = useCallback(async () => {
    const [nextUpdates, nextConflicts, nextTurns, nextAgreements, nextSettings, nextGrants] = await Promise.all([
      window.vibecab.query<VcUpdatesOperation["result"]>("vc.Updates", { artifactId: artifact.artifactId }),
      window.vibecab.query<FeedbackConflict[]>("vc.Conflicts", { sessionId, artifactId: artifact.artifactId }),
      window.vibecab.query<AgentTurn[]>("vc.AgentTurns", { sessionId }),
      window.vibecab.query<Agreement[]>("vc.DecisionRecord", { artifactId: artifact.artifactId }),
      window.vibecab.query<Settings>("sys.Settings", {}),
      window.vibecab.query<Grant[]>("vc.Grants", {}),
    ]);
    setQueryResult(nextUpdates);
    setConflicts(nextConflicts);
    setTurns(nextTurns);
    setAgreements(nextAgreements);
    setSettings(nextSettings);
    setGrants(nextGrants);
    const mostRecent = [...nextUpdates.updates].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
      nextDetail = mostRecent
        ? await window.vibecab.query<Update>("vc.UpdateDetail", { updateId: mostRecent.updateId })
        : undefined;
    setDetail(nextDetail);
    if (nextDetail?.resultVersion) {
      const [nextDiff, base, versions] = await Promise.all([
        window.vibecab.query<DiffResult>("vc.Diff", {
          artifactId: artifact.artifactId,
          from: nextDetail.baseVersion,
          to: nextDetail.resultVersion,
        }),
        window.vibecab.query<Element[]>("vc.Elements", {
          artifactId: artifact.artifactId,
          version: nextDetail.baseVersion,
        }),
        window.vibecab.query<import("../../../../contract/generated/index.js").Version[]>("vc.Versions", {
          artifactId: artifact.artifactId,
        }),
      ]);
      setDiff(nextDiff);
      setBaseElements(base);
      const resultVersion = versions.find((item) => item.version === nextDetail.resultVersion);
      setWrittenByAgent(resultVersion?.createdBy.kind === "agent" && (nextDetail.onBehalfOf?.length ?? 0) > 0);
    }
  }, [artifact.artifactId, sessionId]);
  useEffect(() => {
    void refresh().catch(() => setMessage("Could not load Update status."));
    const refresher = coalesce(refresh);
    const timer = window.setInterval(() => refresher.schedule(), 1_500);
    return () => {
      refresher.stop();
      window.clearInterval(timer);
    };
  }, [refresh]);
  const latestUpdate = detail ?? queryResult.updates.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    active =
      (detail && activeStatus(detail.status) ? detail : undefined) ??
      queryResult.updates.find((update) => activeStatus(update.status)),
    pendingConflictIds = new Set(
      conflicts.filter((conflict) => conflict.state === "open").flatMap((item) => item.itemIds),
    ),
    eligibleAgreements = agreements.filter(
      (item) => item.state === "agreed" && !pendingConflictIds.has(item.agreementId),
    ),
    completed =
      latestUpdate && ["committed", "partially_committed", "failed"].includes(latestUpdate.status)
        ? latestUpdate
        : undefined,
    plan = readPlan(active?.plan),
    noModel = !settings?.models?.default && !settings?.models?.reply;
  const hasAutoAgreeGrant = grants.some((grant) => {
    const sessionScope = grant.scope.sessionIds,
      artifactScope = grant.scope.artifactIds;
    return (
      grant.capabilities.includes("auto_agree_own_proposals") &&
      !grant.revokedAt &&
      (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now()) &&
      (!sessionScope || sessionScope.includes(sessionId)) &&
      (!artifactScope || artifactScope.some((id) => session.artifactIds.includes(id)))
    );
  });

  const command = async (type: string, payload: unknown) => {
    const result = await window.vibecab.command(type, payload);
    if (!result.ok) {
      if (result.error.code === "budget_exceeded") {
        const [budgets, usage] = await Promise.all([
          window.vibecab.query<unknown[]>("sys.Budgets", {}),
          window.vibecab.query<{ accounts: unknown[] }>("sys.Usage", {}),
        ]);
        setMessage(`Today's spend reached its limit. ${JSON.stringify({ budgets, usage: usage.accounts })}`);
      } else setMessage(result.error.message);
      return false;
    }
    setMessage("");
    await Promise.all([refresh(), onRefresh()]);
    return true;
  };
  const setReplyTrigger = async (mode: "realtime" | "batch" | "manual", threadId?: string) => {
    const result = await command("vc.SetReplyTrigger", {
      sessionId,
      ...(threadId ? { threadId } : {}),
      mode,
      ...(mode === "batch" ? { batch: { count: batchCount, idleMinutes } } : {}),
    });
    if (result && !threadId) await onRefresh();
  };
  const resolveConflict = async (conflict: FeedbackConflict, keep: string) =>
    command("vc.ResolveConflict", { keep, supersede: conflict.itemIds.filter((id) => id !== keep) });
  const updatesRemaining = Math.max(0, eligibleAgreements.length);
  const countdown = queryResult.scheduledAt
    ? Math.max(0, Math.ceil((Date.parse(queryResult.scheduledAt) - Date.now()) / 1_000))
    : undefined;

  return (
    <section className="session-workflow" aria-label="Session workflow">
      <header className="workflow-controls">
        <label className="toolbar-field">
          <span className="eyebrow">Replies</span>
          <select
            aria-label="Reply trigger"
            value={session.replyTrigger}
            onChange={(event) => {
              const mode = event.target.value;
              if (mode === "realtime" || mode === "batch" || mode === "manual") void setReplyTrigger(mode);
            }}
          >
            <option value="realtime">Realtime</option>
            <option value="batch">Batch</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        {session.replyTrigger === "batch" ? (
          <label>
            Batch count
            <input
              type="number"
              min={1}
              value={batchCount}
              onChange={(event) => setBatchCount(Number(event.target.value))}
            />
            <input
              aria-label="Batch idle minutes"
              type="number"
              min={0.1}
              step={0.1}
              value={idleMinutes}
              onChange={(event) => setIdleMinutes(Number(event.target.value))}
            />
          </label>
        ) : null}
        <button
          type="button"
          className="toolbar-button"
          disabled={noModel}
          onClick={() => void command("vc.AskAgent", { sessionId })}
          title={noModel ? "Add a model in Settings" : undefined}
        >
          Ask agent
        </button>
        <details className="toolbar-menu">
          <summary>Session menu</summary>
          <label>
            <input
              type="checkbox"
              checked={settings?.sessions[sessionId]?.planReview ?? false}
              onChange={(event) =>
                void command("sys.SetSettings", {
                  patch: { sessions: { [sessionId]: { planReview: event.target.checked } } },
                })
              }
            />
            Review Update plans
          </label>
        </details>
      </header>
      {hasAutoAgreeGrant ? (
        <p className="auto-agree-notice" role="status">
          Agent proposals count as agreed · <a href="#/settings">Settings → Grants</a>
        </p>
      ) : null}
      {noModel ? (
        <p role="status" className="inline-notice">
          Add a model in Settings to use agent replies and Updates.
        </p>
      ) : null}
      {updatesRemaining > 0 ? (
        <section className="update-bar" aria-label="Agreed changes">
          <p className="update-bar-title">
            {updatesRemaining} agreed {updatesRemaining === 1 ? "change" : "changes"}.
            {countdown === undefined ? "" : ` Update starts in ${formatCountdown(countdown)}.`}
          </p>
          <ul>
            {eligibleAgreements.map((item) => (
              <li key={item.agreementId}>
                {threads.flatMap((thread) => thread.comments).find((c) => c.commentId === item.commentId)?.body ??
                  item.instruction}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="primary"
            disabled={!!active || noModel}
            onClick={() => void command("vc.StartUpdate", { artifactId: artifact.artifactId })}
          >
            Update now
          </button>
        </section>
      ) : null}
      <DocumentView
        artifactId={artifact.artifactId}
        version={artifact.headVersion}
        elements={currentElements}
        diff={diff}
        showChanges={showChanges}
        onComment={onComment}
        selectedElementId={selectedElementId}
        commentSlot={commentSlot}
        commentable={commentable}
      />
      {conflicts.some((conflict) => conflict.state === "open") ? (
        <section className="conflict-list" aria-label="Conflicts">
          <h3>Conflicts ({conflicts.filter((item) => item.state === "open").length})</h3>
          {conflicts
            .filter((item) => item.state === "open")
            .map((conflict) => (
              <article key={conflict.conflictId}>
                <p>These agreed changes are excluded until you choose one.</p>
                {conflict.itemIds.map((id) => {
                  const agreement = agreements.find((item) => item.agreementId === id),
                    comment =
                      agreement &&
                      threads
                        .flatMap((thread) => thread.comments)
                        .find((item) => item.commentId === agreement.commentId);
                  return (
                    <div key={id}>
                      <p>{comment?.body ?? agreement?.instruction}</p>
                      {comment?.anchor?.locator ? <blockquote>{comment.anchor.locator.quote}</blockquote> : null}
                      <button type="button" onClick={() => void resolveConflict(conflict, id)}>
                        Keep this one
                      </button>
                    </div>
                  );
                })}
              </article>
            ))}
        </section>
      ) : null}
      {active ? (
        <section aria-label="Update progress" className="update-progress">
          <p className="progress-title">
            <span className="pulse" aria-hidden="true" />
            Update: {statusLabel(active.status)}
          </p>
          <ol className="stepper" aria-hidden="true">
            {["queued", "planning", "awaiting_plan_review", "writing", "checking"].map((step) => (
              <li
                key={step}
                data-done={stepIndex(active.status) > stepIndex(step) || undefined}
                data-current={active.status === step || undefined}
              >
                {step === "awaiting_plan_review" ? "review" : step}
              </li>
            ))}
          </ol>
          {plan.map((item) => (
            <article key={item.itemId}>
              <p>
                {item.action}: {item.note}
              </p>
              {item.elementIds.map((id) => (
                <button type="button" key={id} onClick={() => onFocusElement(id)}>
                  Highlight element
                </button>
              ))}
            </article>
          ))}
          {active.status === "awaiting_plan_review" ? (
            <>
              <button type="button" onClick={() => void command("vc.ApprovePlan", { updateId: active.updateId })}>
                Approve plan
              </button>
              <button type="button" onClick={() => cancel(active.updateId)}>
                Cancel
              </button>
            </>
          ) : active.status !== "checking" ? (
            <button type="button" onClick={() => cancel(active.updateId)}>
              Cancel Update
            </button>
          ) : null}
        </section>
      ) : null}
      {completed ? (
        <UpdateResult
          update={completed}
          agreements={agreements}
          threads={threads}
          writtenByAgent={writtenByAgent}
          onRetry={() => void command("vc.StartUpdate", { artifactId: artifact.artifactId })}
        />
      ) : null}
      {diff && completed?.resultVersion ? (
        <section aria-label="Update diff" className="update-result">
          <h3>
            v{completed.baseVersion} → v{completed.resultVersion}
          </h3>
          {completed.status === "partially_committed" ? <p>Some items were held back and are agreed again.</p> : null}
          <div className="card-actions">
            <button type="button" onClick={() => setShowChanges((shown) => !shown)}>
              {showChanges ? "Clean view" : "Show changes"}
            </button>
            <button type="button" onClick={() => setDiff(undefined)}>
              Dismiss changes
            </button>
          </div>
          <UpdateDiff
            diff={diff}
            baseElements={baseElements}
            currentElements={currentElements}
            showChanges={showChanges}
            onFocusElement={onFocusElement}
          />
        </section>
      ) : null}
      <section aria-label="Agent turns" className="agent-turns">
        {turns.map((turn) => (
          <p key={turn.turnId}>
            {turn.status === "running" ? "Agent is reading…" : null}
            {turn.status === "failed" || turn.status === "uncertain"
              ? `Agent reply ${turn.status}: ${turnFailureText(turn.errorCode)}`
              : null}
            {turn.status === "failed" || turn.status === "uncertain" ? (
              <button
                type="button"
                onClick={() =>
                  void command("vc.AskAgent", {
                    sessionId,
                    ...(turn.trigger.threadIds?.length ? { threadIds: turn.trigger.threadIds } : {}),
                  })
                }
              >
                Retry
              </button>
            ) : null}
          </p>
        ))}
      </section>
      {message ? <p role="alert">{message}</p> : null}
    </section>
  );

  async function cancel(updateId: string) {
    if (window.confirm("Cancel this Update?")) await command("vc.CancelUpdate", { updateId });
  }
}

function UpdateResult({
  update,
  agreements,
  threads,
  writtenByAgent,
  onRetry,
}: {
  update: Update;
  agreements: Agreement[];
  threads: VcThreadsOperation["result"];
  writtenByAgent: boolean;
  onRetry: () => void;
}) {
  return (
    <section aria-label="Update result" className="update-result receipt">
      <h3 className="eyebrow">Update result</h3>
      <p className="meta">{updateResultCounts(update.itemResults)}</p>
      {update.itemResults.map((result) => {
        const agreement = agreements.find((item) => item.agreementId === result.itemId),
          comment =
            agreement &&
            threads.flatMap((thread) => thread.comments).find((item) => item.commentId === agreement.commentId);
        return (
          <p key={result.itemId}>
            {comment?.body ?? agreement?.instruction} —{" "}
            {result.status === "addressed" ? "Applied" : `Not applied: ${result.reason ?? "held back"}`}
          </p>
        );
      })}
      {update.status === "failed" ? (
        <p>
          Update failed. Your agreements are ready to try again. <button onClick={onRetry}>Try again</button>
        </p>
      ) : null}
      {writtenByAgent ? <p className="meta">Written by the agent for you.</p> : null}
    </section>
  );
}

function readPlan(value: Update["plan"]): PlanItem[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const items = Reflect.get(value, "items");
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is PlanItem => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    return (
      typeof Reflect.get(item, "itemId") === "string" &&
      typeof Reflect.get(item, "action") === "string" &&
      Array.isArray(Reflect.get(item, "elementIds")) &&
      typeof Reflect.get(item, "note") === "string"
    );
  });
}

function stepIndex(status: string): number {
  return ["queued", "planning", "awaiting_plan_review", "writing", "checking", "committed"].indexOf(status);
}

function activeStatus(status: Update["status"]): boolean {
  return ["queued", "planning", "awaiting_plan_review", "writing", "checking"].includes(status);
}

function statusLabel(status: Update["status"]): string {
  return status.replaceAll("_", " ");
}

function updateResultCounts(results: Update["itemResults"]): string {
  const applied = results.filter((item) => item.status === "addressed").length,
    notApplied = results.filter((item) => item.status === "not_addressed").length;
  return `${applied} item${applied === 1 ? "" : "s"} applied · ${notApplied} not applied`;
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function turnFailureText(code: string | undefined): string {
  if (code === "budget_exceeded") return "the session budget was reached. Check today's usage.";
  if (code === "unavailable") return "the model is not configured or unavailable.";
  if (code === "uncertain") return "the provider response could not be confirmed.";
  return "the reply did not complete. Try again.";
}
