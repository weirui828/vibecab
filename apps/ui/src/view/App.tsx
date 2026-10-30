import { useEffect, useState } from "react";
import { Button, Card, CardBody } from "@wei/design-system";
import type { Settings, VcArtifactsOperation, VcSessionsOperation } from "../../../../contract/generated/index.js";
import { createBlank, importMarkdown as importMarkdownContent, listArtifacts } from "../api/artifacts.js";
import { attachArtifact, listSessions, startSession } from "../api/sessions.js";
import { terms } from "../copy/terms.js";
import { connectionTransition } from "../connection.js";
import type { ConnectionEvent, ConnectionState } from "../connection.js";
import type { AttentionItem } from "../../../../contract/generated/index.js";
import { SessionView } from "../session/SessionView.js";
import { Onboarding } from "./Onboarding.js";

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
    [showNewDraft, setShowNewDraft] = useState(false);
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
    const unlisten = window.vibecab.subscribe(0, {}, () => {
      void refresh();
    });
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
  return (
    <div className="shell">
      <aside className="sidebar">
        <h1 className="brand">VibeCab</h1>
        <p className="eyebrow">Workspace</p>
        <p>
          <button
            onClick={() => {
              setSelected("");
              window.location.hash = "/";
            }}
          >
            {terms.draft}s <span>{artifacts.length}</span>
          </button>
        </p>
        <div>
          {sessions.map((session) => (
            <div key={session.sessionId} className="session-nav-item">
              <button
                className="draft"
                onClick={() => {
                  setSelected("");
                  window.location.hash = "/s/" + encodeURIComponent(session.sessionId);
                }}
              >
                {session.title}{" "}
                <small>
                  {session.state} · {attention.filter((item) => item.sessionId === session.sessionId).length} needs you
                </small>
              </button>
              <button
                aria-label={`Rename ${session.title}`}
                onClick={() => {
                  const title = window.prompt("Rename Session", session.title);
                  if (title)
                    void window.vibecab
                      .command("vc.RenameSession", { sessionId: session.sessionId, title })
                      .then(refresh);
                }}
              >
                Rename
              </button>
              <button
                aria-label={`Move ${session.title} to trash`}
                onClick={() => {
                  void window.vibecab
                    .command("vc.Trash", { target: { kind: "session", id: session.sessionId } })
                    .then(() => {
                      setUndoTarget({ kind: "session", id: session.sessionId });
                      return refresh();
                    });
                }}
              >
                Trash
              </button>
            </div>
          ))}
        </div>
        <p>
          <button
            onClick={() => {
              window.location.hash = "/settings";
            }}
          >
            Settings
          </button>
        </p>
        <p className="notice">{state}</p>
        {state === "Engine stopped" || state === "Engine unreachable" ? (
          <Button onClick={() => void window.vibecab.app.startEngine().then(() => setConnection("connected"))}>
            Start engine
          </Button>
        ) : null}
        <label>
          Theme{" "}
          <select
            defaultValue="system"
            onChange={(event) => {
              const value = event.target.value;
              if (value === "system" || value === "light" || value === "dark") void window.vibecab.app.setTheme(value);
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </aside>
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
          <>
            <div className="row">
              <h2>Settings</h2>
              <Button
                variant="secondary"
                onClick={() => {
                  window.location.hash = "/";
                }}
              >
                Back
              </Button>
            </div>
            <p>Model configuration and theme preferences are available here.</p>
          </>
        ) : selectedArtifact ? (
          <>
            <div className="row">
              <div>
                <p className="eyebrow">{terms.draft}</p>
                <h2>{selectedArtifact.title}</h2>
              </div>
              <Button variant="secondary" onClick={() => setSelected("")}>
                Back
              </Button>
            </div>
            <Card>
              <CardBody>
                <p>
                  {terms.document} · Version {selectedArtifact.headVersion}
                </p>
              </CardBody>
            </Card>
          </>
        ) : (
          <>
            {activeSession ? (
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
              <>
                <div className="row">
                  <div>
                    <p className="eyebrow">Workspace</p>
                    <h2>Your {terms.draft}s</h2>
                  </div>
                  <Button onClick={() => setShowNewDraft((shown) => !shown)}>New {terms.draft.toLowerCase()}</Button>
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
                </div>
                {showNewDraft ? (
                  <Card>
                    <CardBody>
                      <label className="draft-session-select">
                        Add to session
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
                      <div className="row">
                        <Button
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
                    </CardBody>
                  </Card>
                ) : null}
                {error ? (
                  <p role="alert" className="notice">
                    {error}
                  </p>
                ) : null}
                <label className="home-filter">
                  Filter Drafts{" "}
                  <input
                    aria-label="Filter Drafts"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </label>
                <section aria-label="Needs you">
                  <h3>Needs you</h3>
                  {groupedAttention.size ? (
                    Array.from(groupedAttention, ([group, items]) => (
                      <div key={group}>
                        <h4>{sessions.find((session) => session.sessionId === group)?.title ?? "Workspace"}</h4>
                        {items.map((item) => (
                          <button
                            className="draft"
                            key={item.kind + item.id}
                            onClick={() => {
                              if (item.sessionId) window.location.hash = "/s/" + encodeURIComponent(item.sessionId);
                            }}
                          >
                            {item.kind.replaceAll("_", " ")}
                          </button>
                        ))}
                      </div>
                    ))
                  ) : (
                    <p>No items need your attention.</p>
                  )}
                </section>
                {undoTarget ? (
                  <p role="status">
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
                {artifacts.length === 0 ? (
                  <Card>
                    <CardBody>
                      <p>Start with a blank document or bring in a Markdown file.</p>
                      <Button onClick={() => setShowNewDraft(true)}>New {terms.draft.toLowerCase()}</Button>
                    </CardBody>
                  </Card>
                ) : (
                  <div className="list">
                    {artifacts
                      .filter((artifact) => artifact.title.toLowerCase().includes(filter.toLowerCase()))
                      .map((artifact) => (
                        <article className="draft" key={artifact.artifactId}>
                          <button className="draft-open" onClick={() => setSelected(artifact.artifactId)}>
                            <strong>{artifact.title}</strong>
                            <span> · {terms.document}</span>
                            <small>
                              {" "}
                              · Updated {new Date(artifact.updatedAt).toLocaleDateString()} · Sessions:{" "}
                              {sessions
                                .filter((session) => session.artifactIds.includes(artifact.artifactId))
                                .map((session) => session.title)
                                .join(", ") || "None"}
                            </small>
                          </button>
                          <div className="draft-actions">
                            <button
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
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
