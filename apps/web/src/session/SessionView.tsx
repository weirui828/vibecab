import { useEffect, useState } from "react";
import { Button, Icon } from "@wei/design-system";
import type {
  Element,
  SessionDigest,
  VcArtifactOperation,
  VcResumeViewOperation,
} from "../../../../contract/generated/index.js";
import { terms } from "../../../ui/src/copy/terms.js";
import { useBridge, useLiveQuery } from "../live/LiveStore.js";
import type { DraftRow, SessionRow } from "../live/workspace.js";
import { useDialogs } from "../home/DialogHost.js";
import { useActions } from "../home/actions.js";
import { Menu } from "../ui/Menu.js";
import type { MenuItem } from "../ui/Menu.js";
import { plural, relativeTime } from "../ui/time.js";
import { navigate } from "../shell/prefs.js";
import { CatchUp } from "./CatchUp.js";
import { DraftDocument } from "./DraftDocument.js";
import { useLoop } from "./loop.js";
import type { Loop } from "./loop.js";
import { useMarkSeen } from "./useMarkSeen.js";
import { byElementId } from "./textRanges.js";

/** `/s/:sessionId` or `/s/:sessionId/d/:artifactId`. */
export function parseSessionRoute(route: string): { sessionId: string; artifactId?: string } | undefined {
  const match = /^\/s\/([^/]+)(?:\/d\/([^/]+))?$/.exec(route);
  if (!match?.[1]) return undefined;
  return match[2] ? { sessionId: match[1], artifactId: match[2] } : { sessionId: match[1] };
}

export function SessionView({ session, artifactId }: { session: SessionRow; artifactId?: string }) {
  const drafts = useLiveQuery<DraftRow[]>("vc.Artifacts", { sessionId: session.sessionId });
  // The primary Draft first, then the others in the order they were attached (the order the engine returns).
  const ordered = [...(drafts.data ?? [])].sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"));
  const current = ordered.find((d) => d.artifactId === artifactId) ?? ordered[0];
  const loop = useLoop(session.sessionId, current?.artifactId ?? "", current !== undefined);
  if (drafts.loading)
    return (
      <div className="vc-session">
        <SessionHeader session={session} drafts={[]} current={undefined} loop={loop} />
        <div className="vc-doc-wrap">
          <DocSkeleton />
        </div>
      </div>
    );
  return (
    <div className="vc-session">
      <SessionHeader session={session} drafts={ordered} current={current} loop={loop} />
      <ResumeStrip sessionId={session.sessionId} />
      <div className="vc-doc-wrap">
        {current ? (
          <DraftDocument
            key={current.artifactId}
            session={session}
            artifactId={current.artifactId}
            loop={loop}
            skeleton={<DocSkeleton />}
          />
        ) : (
          <EmptySession session={session} />
        )}
      </div>
    </div>
  );
}

function SessionHeader({
  session,
  drafts,
  current,
  loop,
}: {
  session: SessionRow;
  drafts: DraftRow[];
  current: DraftRow | undefined;
  loop: Loop;
}) {
  const dialogs = useDialogs(),
    actions = useActions(),
    artifact = useLiveQuery<VcArtifactOperation["result"]>(
      "vc.Artifact",
      { artifactId: current?.artifactId ?? "" },
      current !== undefined,
    ),
    elements = useLiveQuery<Element[]>("vc.Elements", { artifactId: current?.artifactId ?? "" }, current !== undefined);
  const blocks = elements.data?.filter((e) => e.parentId === null).length;
  const facts = [
    session.state === "active" ? undefined : session.state === "paused" ? terms.paused : terms.ended,
    artifact.data ? `version ${artifact.data.headVersion}` : undefined,
    blocks !== undefined ? plural(blocks, "block") : undefined,
    artifact.data ? `updated ${relativeTime(artifact.data.updatedAt)}` : undefined,
    loop.autoAgree ? "Agent proposals count as agreed" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const menu: MenuItem[] = [
    ...(session.state !== "ended"
      ? [
          { label: `Add a ${terms.draft.toLowerCase()}`, onSelect: () => dialogs.newDraft(session.sessionId) },
          {
            label: `Bring in a ${terms.draft.toLowerCase()}`,
            onSelect: () => dialogs.attachDraft(session.sessionId),
          },
        ]
      : []),
    ...(session.state !== "ended" && current
      ? [
          {
            label: loop.planReview ? "Stop reviewing plans" : "Review each plan before writing",
            onSelect: () => void actions.setSessionSettings(session.sessionId, { planReview: !loop.planReview }),
          },
        ]
      : []),
    {
      label: "Rename",
      separatorBefore: session.state !== "ended",
      onSelect: () => dialogs.rename("session", session.sessionId, session.title),
    },
    ...(session.state === "active"
      ? [{ label: "Pause", onSelect: () => void actions.setSessionState(session.sessionId, "pause") }]
      : session.state === "paused"
        ? [{ label: "Resume", onSelect: () => void actions.setSessionState(session.sessionId, "resume") }]
        : []),
    ...(session.state !== "ended"
      ? [{ label: "End", onSelect: () => void actions.setSessionState(session.sessionId, "end") }]
      : []),
    {
      label: "Move to Trash",
      tone: "danger",
      separatorBefore: true,
      onSelect: () => {
        void actions.trash("session", session.sessionId, session.title);
        navigate("/");
      },
    },
  ];
  return (
    <header className="vc-session-head">
      <div className="title">
        <h1>{session.title}</h1>
        {facts && <p className="vc-facts">{facts}</p>}
      </div>
      {drafts.length > 1 && (
        <nav
          className="vc-segmented vc-draft-tabs"
          aria-label={`${terms.draft}s in this ${terms.session.toLowerCase()}`}
        >
          {drafts.map((d) => (
            <a
              key={d.artifactId}
              href={`#/s/${session.sessionId}/d/${d.artifactId}`}
              aria-current={d.artifactId === current?.artifactId ? "page" : undefined}
            >
              {d.title}
            </a>
          ))}
        </nav>
      )}
      <div className="end">
        <Menu label={`${terms.session} actions`} items={menu} />
      </div>
    </header>
  );
}

function ResumeStrip({ sessionId }: { sessionId: string }) {
  const bridge = useBridge(),
    [resume, setResume] = useState<VcResumeViewOperation["result"]>(),
    [digest, setDigest] = useState<SessionDigest>(),
    [dismissed, setDismissed] = useState(false);
  // Read once when the session opens: the strip describes what happened before this visit.
  useEffect(() => {
    let alive = true;
    setResume(undefined);
    setDismissed(false);
    void bridge
      .query<VcResumeViewOperation["result"]>("vc.ResumeView", { sessionId })
      .then((value) => alive && setResume(value))
      .catch(() => undefined);
    void bridge
      .query<SessionDigest[]>("vc.Digest", { sessionId })
      .then((value) => alive && setDigest(value.at(-1)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [bridge, sessionId]);
  const markSeen = useMarkSeen(sessionId);
  if (!resume || dismissed) return null;
  return (
    <CatchUp
      resume={resume}
      digest={digest}
      onDismiss={() => {
        setDismissed(true);
        markSeen();
      }}
      onJump={(elementId) => {
        const node = document.querySelector(byElementId(elementId));
        node?.scrollIntoView({ behavior: "smooth", block: "center" });
        node?.classList.add("vc-flash");
        setTimeout(() => node?.classList.remove("vc-flash"), 1600);
      }}
    />
  );
}

function EmptySession({ session }: { session: SessionRow }) {
  const dialogs = useDialogs();
  return (
    <div className="vc-session-empty">
      <p className="vc-doc-empty">No {terms.draft.toLowerCase()} here yet.</p>
      <p className="vc-muted">Add one to start working on it with the agent.</p>
      {session.state !== "ended" && (
        <div className="vc-actions">
          <Button
            variant="primary"
            leadingIcon={<Icon name="plus" />}
            onClick={() => dialogs.newDraft(session.sessionId)}
          >
            Add a {terms.draft.toLowerCase()}
          </Button>
          <Button variant="ghost" onClick={() => dialogs.attachDraft(session.sessionId)}>
            Bring one in
          </Button>
        </div>
      )}
    </div>
  );
}

function DocSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="vc-skeleton-line" style={{ width: "70%", height: 40 }} />
      {[92, 100, 84, 96, 60].map((w, i) => (
        <div key={i} className="vc-skeleton-line" style={{ width: `${w}%`, marginTop: i === 0 ? 40 : 14 }} />
      ))}
    </div>
  );
}
