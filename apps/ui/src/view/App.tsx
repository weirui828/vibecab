import { useEffect, useState } from "react";
import { Button } from "@wei/design-system";
import { Hills, Mound } from "./Brand.js";
import { Sidebar } from "./Sidebar.js";
import { WindowDragRegion } from "./WindowDragRegion.js";
import type { Settings, VcArtifactsOperation, VcSessionsOperation } from "../../../../contract/generated/index.js";
import { createBlank, importMarkdown as importMarkdownContent, listArtifacts } from "../api/artifacts.js";
import { attachArtifact, listSessions, startSession } from "../api/sessions.js";
import { terms } from "../copy/terms.js";
import { connectionTransition } from "../connection.js";
import { coalesce } from "../coalesce.js";
import type { ConnectionEvent, ConnectionState } from "../connection.js";
import type { AttentionItem } from "../../../../contract/generated/index.js";
import { SessionView } from "../session/SessionView.js";
import { Onboarding } from "./Onboarding.js";
import { SettingsView } from "./SettingsView.js";
import { TrashView } from "./TrashView.js";

export function App() {
  const [state, setState] = useState<ConnectionState>("Starting"),
    [artifacts, setArtifacts] = useState<VcArtifactsOperation["result"]>([]),
    [sessions, setSessions] = useState<VcSessionsOperation["result"]>([]),
    [error, setError] = useState(""),
    [attention, setAttention] = useState<AttentionItem[]>([]),
    [filter, setFilter] = useState(""),
    [undoTarget, setUndoTarget] = useState<{ kind: "artifact" | "session"; id: string } | undefined>(),
    [draftSessionId, setDraftSessionId] = useState("new"),
    [onboarding, setOnboarding] = useState(false),
    [selected, setSelected] = useState(""),
    [route, setRoute] = useState(window.location.hash.slice(1) || "/"),
    [showNewDraft, setShowNewDraft] = useState(false),
    [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const setConnection = (event: ConnectionEvent) => setState((current) => connectionTransition(current, event));
  const refresh = async () => {
    try {
      const [nextArtifacts, nextSessions, nextAttention] = await Promise.all([
        listArtifacts(),
        listSessions(),
        window.vibecab.query<AttentionItem[]>("vc.AttentionInbox", {}),
      ]);
      nextArtifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setArtifacts(nextArtifacts);
      setSessions(nextSessions);
      setAttention(nextAttention);
      setConnection("connected");
      setError("");
    } catch {
      setConnection("unreachable");
    }
  };
  useEffect(() => {
    void window.vibecab.app.state().then((current) => setConnection(current === "Connected" ? "connected" : "stopped"));
    void refresh();
    void Promise.all([listArtifacts(), window.vibecab.query<Settings>("sys.Settings", {})]).then(
      ([existing, settings]) => {
        const models = settings.models;
        if (!existing.length || !models || typeof models !== "object" || !Reflect.get(models, "default"))
          setOnboarding(true);
      },
    );
    const refresher = coalesce(refresh);
    const unlisten = window.vibecab.subscribe(0, {}, () => refresher.schedule());
    const newDraft = window.vibecab.app.onNewDraft(() => setShowNewDraft(true)),
      importFile = window.vibecab.app.onImport(() => void importMarkdown());
    const theme = window.vibecab.app.onTheme((dark) => document.documentElement.classList.toggle("dark", dark));
    const lost = window.vibecab.app.onConnectionLost(() => {
      setConnection("unreachable");
      void refresh();
    });
    const onHash = () => setRoute(window.location.hash.slice(1) || "/"),
      navigate = window.vibecab.app.onNavigate((path) => {
        window.location.hash = path;
      });
    window.addEventListener("hashchange", onHash);
    return () => {
      refresher.stop();
      unlisten();
      newDraft();
      importFile();
      theme();
      lost();
      navigate();
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  const createDraft = async (content?: string, title?: string, targetSessionId = draftSessionId) => {
    try {
      const record =
        content === undefined
          ? await createBlank(title ?? "Untitled")
          : await importMarkdownContent(title ?? "Untitled", content);
      const sessionId =
        targetSessionId === "new" ? (await startSession(title ?? "New session")).sessionId : targetSessionId;
      await attachArtifact(sessionId, record.artifactId);
      await refresh();
      setSelected("");
      window.location.hash = "/s/" + encodeURIComponent(sessionId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not create draft.");
    }
  };
  const importMarkdown = async () => {
    const file = await window.vibecab.app.openMarkdown();
    if (file) await createDraft(file.content, file.name.replace(/\.md$/i, ""));
  };
  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selected);
  const activeSessionId = route.match(/^\/s\/([^/]+)$/)?.[1],
    activeSession = sessions.find((session) => session.sessionId === decodeURIComponent(activeSessionId ?? ""));
  const groupedAttention = new Map<string, AttentionItem[]>();
  for (const item of attention) {
    const group = item.sessionId ?? "workspace";
    groupedAttention.set(group, [...(groupedAttention.get(group) ?? []), item]);
  }
  const needsYou = (sessionId: string) => attention.filter((item) => item.sessionId === sessionId).length;
  const filteredArtifacts = artifacts.filter((artifact) => artifact.title.toLowerCase().includes(filter.toLowerCase()));
  const sessionsFor = (artifactId: string) =>
    sessions.filter((session) => session.artifactIds.includes(artifactId)).map((session) => session.title);
  const openArtifact = (artifactId: string) => {
    const owner = sessions.find((session) => session.artifactIds.includes(artifactId));
    if (owner) {
      setSelected("");
      window.location.hash = "/s/" + encodeURIComponent(owner.sessionId);
    } else setSelected(artifactId);
  };
  const homeMeta = [
    `${artifacts.length} ${artifacts.length === 1 ? terms.draft.toLowerCase() : terms.draft.toLowerCase() + "s"}`,
    `${sessions.length} ${sessions.length === 1 ? terms.session.toLowerCase() : terms.session.toLowerCase() + "s"}`,
    attention.length ? `${attention.length} need${attention.length === 1 ? "s" : ""} you` : "nothing waiting",
  ].join(" · ");
  return (
    <div className="shell">
      <WindowDragRegion />
      <Sidebar
        artifactsCount={artifacts.length}
        sessions={sessions}
        activeSessionId={activeSession?.sessionId}
        onHome={!activeSession && route === "/"}
        state={state}
        theme={theme}
        setTheme={setTheme}
        needsYou={needsYou}
        onSelectNone={() => setSelected("")}
        onConnected={() => setConnection("connected")}
        onRefresh={refresh}
        onError={setError}
        onTrashed={setUndoTarget}
      />
      <main className="main">
        {onboarding ? (
          <Onboarding
            onSkip={() => {
              setOnboarding(false);
              setShowNewDraft(true);
            }}
            onSave={async (baseUrl, model, key) => {
              await window.vibecab.app.saveProvider(baseUrl, model, key);
              setOnboarding(false);
              setShowNewDraft(true);
            }}
          />
        ) : route === "/settings" ? (
          <SettingsView
            onBack={() => {
              window.location.hash = "/";
            }}
          />
        ) : route === "/trash" ? (
          <TrashView
            onBack={() => {
              window.location.hash = "/";
            }}
            onChanged={() => void refresh()}
          />
        ) : selectedArtifact ? (
          <div className="page">
            <header className="page-header">
              <div>
                <p className="eyebrow">{terms.draft}</p>
                <h2 className="page-title">{selectedArtifact.title}</h2>
                <p className="meta">
                  {terms.document} · v{selectedArtifact.headVersion} · not in a {terms.session.toLowerCase()} yet
                </p>
              </div>
              <div className="page-actions">
                <Button variant="secondary" onClick={() => setSelected("")}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  onClick={() =>
                    void startSession(selectedArtifact.title)
                      .then(async ({ sessionId }) => {
                        await attachArtifact(sessionId, selectedArtifact.artifactId);
                        await refresh();
                        setSelected("");
                        window.location.hash = "/s/" + encodeURIComponent(sessionId);
                      })
                      .catch((failure) => setError(String(failure)))
                  }
                >
                  Open in a new {terms.session.toLowerCase()}
                </Button>
              </div>
            </header>
          </div>
        ) : activeSession ? (
          <SessionView
            key={activeSession.sessionId}
            sessionId={activeSession.sessionId}
            session={activeSession}
            title={activeSession.title}
            artifacts={artifacts.filter((artifact) => activeSession.artifactIds.includes(artifact.artifactId))}
            availableArtifacts={artifacts}
            onAddDraft={async () => {
              const draft = await createBlank("Untitled");
              await attachArtifact(activeSession.sessionId, draft.artifactId);
              await refresh();
            }}
            onBack={() => {
              window.location.hash = "/";
              void refresh();
            }}
            onRefresh={() => void refresh()}
          />
        ) : (
          <div className="page">
            <header className="page-header">
              <div>
                <p className="eyebrow">Workspace</p>
                <h2 className="page-title">Your {terms.draft}s</h2>
                <p className="meta">{homeMeta}</p>
              </div>
              <div className="page-actions">
                <Button
                  variant="secondary"
                  onClick={() =>
                    void startSession("New session")
                      .then(refresh)
                      .catch((failure) => setError(String(failure)))
                  }
                >
                  New {terms.session.toLowerCase()}
                </Button>
                <Button variant="primary" onClick={() => setShowNewDraft((shown) => !shown)}>
                  New {terms.draft.toLowerCase()}
                </Button>
              </div>
            </header>
            {showNewDraft ? (
              <section className="panel new-draft" aria-label={`New ${terms.draft.toLowerCase()}`}>
                <p className="eyebrow">New {terms.draft.toLowerCase()}</p>
                <div className="new-draft-row">
                  <label className="field">
                    <span>Add to session</span>
                    <select
                      aria-label="Add to session"
                      value={draftSessionId}
                      onChange={(event) => setDraftSessionId(event.target.value)}
                    >
                      <option value="new">New session</option>
                      {sessions.map((session) => (
                        <option key={session.sessionId} value={session.sessionId}>
                          {session.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="primary"
                    onClick={() => {
                      setShowNewDraft(false);
                      void createDraft();
                    }}
                  >
                    Blank {terms.document}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setShowNewDraft(false);
                      void importMarkdown();
                    }}
                  >
                    Import Markdown
                  </Button>
                </div>
              </section>
            ) : null}
            {error ? (
              <p role="alert" className="notice">
                {error}
              </p>
            ) : null}
            {artifacts.length === 0 ? (
              <section className="empty-state" aria-label="Empty workspace">
                <Hills />
                <h3 className="empty-title">Nothing drafted yet.</h3>
                <p>
                  Start a {terms.document.toLowerCase()}, leave comments where it feels off, and let the agent do the
                  rewriting you agree to.
                </p>
                <Button variant="primary" onClick={() => setShowNewDraft(true)}>
                  New {terms.draft.toLowerCase()}
                </Button>
                <ol className="steps">
                  <li>Start a {terms.draft.toLowerCase()}</li>
                  <li>Comment where it feels off</li>
                  <li>Agree, and the agent updates it</li>
                </ol>
              </section>
            ) : (
              <>
                <section aria-label="Needs you" className="home-section">
                  <h3 className="section-label">Needs you</h3>
                  {groupedAttention.size ? (
                    <div className="attention-grid">
                      {Array.from(groupedAttention, ([group, items]) => (
                        <div key={group} className="attention-card">
                          <h4>
                            <Mound tone="attention" />
                            {sessions.find((session) => session.sessionId === group)?.title ?? "Workspace"}
                          </h4>
                          <div className="chips">
                            {items.map((item) => (
                              <button
                                className="chip"
                                key={item.kind + item.id}
                                onClick={() => {
                                  if (item.sessionId) window.location.hash = "/s/" + encodeURIComponent(item.sessionId);
                                }}
                              >
                                {attentionLabel(item.kind)}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="quiet">No items need your attention.</p>
                  )}
                </section>
                <section className="home-section" aria-label={`${terms.draft}s`}>
                  <div className="row">
                    <h3 className="section-label">All {terms.draft.toLowerCase()}s</h3>
                    <label className="search">
                      <span className="visually-hidden">Filter Drafts</span>
                      <input
                        aria-label="Filter Drafts"
                        placeholder={`Filter ${terms.draft.toLowerCase()}s`}
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="draft-list">
                    {filteredArtifacts.map((artifact) => (
                      <article className="draft-row" key={artifact.artifactId}>
                        <button className="draft-open" onClick={() => openArtifact(artifact.artifactId)}>
                          <strong>{artifact.title}</strong>
                          <span className="meta">
                            {terms.document} · v{artifact.headVersion} · updated {relativeDay(artifact.updatedAt)}
                            {sessionsFor(artifact.artifactId).length
                              ? ` · in ${sessionsFor(artifact.artifactId).join(", ")}`
                              : ""}
                          </span>
                        </button>
                        <div className="draft-actions">
                          <button
                            className="quiet-action"
                            onClick={() => {
                              const title = window.prompt("Rename Draft", artifact.title);
                              if (title)
                                void window.vibecab
                                  .command("vc.RenameArtifact", { artifactId: artifact.artifactId, title })
                                  .then(refresh);
                            }}
                          >
                            Rename
                          </button>
                          <button
                            className="quiet-action"
                            onClick={() => {
                              void window.vibecab
                                .command("vc.Trash", { target: { kind: "artifact", id: artifact.artifactId } })
                                .then(() => {
                                  setUndoTarget({ kind: "artifact", id: artifact.artifactId });
                                  return refresh();
                                });
                            }}
                          >
                            Move to trash
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              </>
            )}
            {undoTarget ? (
              <p role="status" className="toast">
                Moved to trash.{" "}
                <button
                  onClick={() => {
                    void window.vibecab.command("vc.Restore", { target: undoTarget }).then(refresh);
                    setUndoTarget(undefined);
                  }}
                >
                  Undo
                </button>
              </p>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}

function attentionLabel(kind: AttentionItem["kind"]): string {
  const labels: Record<AttentionItem["kind"], string> = {
    conflict: "Conflict to resolve",
    agreed_item: "Agreed, waiting for an Update",
    unread_reply: "Unread reply",
    proposal: "Proposal to review",
    new_version: "New version",
    running_update: "Update running",
    failed_update: "Update failed",
    output_set: "New Snapshot",
  };
  return labels[kind];
}

function relativeDay(timestamp: string): string {
  const days = Math.round((Date.parse(timestamp) - Date.now()) / 86_400_000);
  if (days === 0) return "today";
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(days, "day");
}
