import { useEffect, useState } from "react";
import { Button, Card, CardBody, Spinner } from "@wei/design-system";
import type { Settings, VcArtifactsOperation, VcSessionsOperation } from "../../../../contract/generated/index.js";
import { createBlank, importMarkdown as importMarkdownContent, listArtifacts } from "../api/artifacts.js";
import { attachArtifact, listSessions, startSession } from "../api/sessions.js";
import { terms } from "../copy/terms.js";
import { connectionTransition } from "../connection.js";
import type { ConnectionEvent, ConnectionState } from "../connection.js";

export function App() {
  const [state, setState] = useState<ConnectionState>("Starting"),
    [artifacts, setArtifacts] = useState<VcArtifactsOperation["result"]>([]),
    [sessions, setSessions] = useState<VcSessionsOperation["result"]>([]),
    [error, setError] = useState(""),
    [onboarding, setOnboarding] = useState(false),
    [selected, setSelected] = useState(""),
    [route, setRoute] = useState(window.location.hash.slice(1) || "/"),
    [showNewDraft, setShowNewDraft] = useState(false);
  const setConnection = (event: ConnectionEvent) => setState((current) => connectionTransition(current, event));
  const refresh = async () => {
    try {
      const [nextArtifacts, nextSessions] = await Promise.all([listArtifacts(), listSessions()]);
      setArtifacts(nextArtifacts);
      setSessions(nextSessions);
      setConnection("connected");
      setError("");
    } catch {
      setConnection("unreachable");
    }
  };
  useEffect(() => {
    void window.vibecab.app.state().then((current) => setConnection(current === "Connected" ? "connected" : "stopped"));
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
  const createDraft = async (content?: string, title?: string) => {
    try {
      const record =
        content === undefined
          ? await createBlank(title ?? "Untitled")
          : await importMarkdownContent(title ?? "Untitled", content);
      const session = await startSession(title ?? "New session");
      await attachArtifact(session.sessionId, record.artifactId);
      await refresh();
      setSelected("");
      window.location.hash = "/s/" + encodeURIComponent(session.sessionId);
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
            <button
              className="draft"
              key={session.sessionId}
              onClick={() => {
                setSelected("");
                window.location.hash = "/s/" + encodeURIComponent(session.sessionId);
              }}
            >
              {session.title}
            </button>
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
              <>
                <div className="row">
                  <div>
                    <p className="eyebrow">{terms.session}</p>
                    <h2>{activeSession.title}</h2>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      window.location.hash = "/";
                    }}
                  >
                    Back
                  </Button>
                </div>
                <p>Drafts and conversations for this session will appear here.</p>
                {artifacts
                  .filter((artifact) => activeSession.artifactIds.includes(artifact.artifactId))
                  .map((artifact) => (
                    <button
                      className="draft"
                      key={artifact.artifactId}
                      onClick={() => setSelected(artifact.artifactId)}
                    >
                      {artifact.title}
                    </button>
                  ))}
              </>
            ) : (
              <>
                <div className="row">
                  <div>
                    <p className="eyebrow">Workspace</p>
                    <h2>Your {terms.draft}s</h2>
                  </div>
                  <Button onClick={() => setShowNewDraft((shown) => !shown)}>New {terms.draft.toLowerCase()}</Button>
                </div>
                {showNewDraft ? (
                  <Card>
                    <CardBody>
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
                {artifacts.length === 0 ? (
                  <Card>
                    <CardBody>
                      <p>Start with a blank document or bring in a Markdown file.</p>
                      <Button onClick={() => setShowNewDraft(true)}>New {terms.draft.toLowerCase()}</Button>
                    </CardBody>
                  </Card>
                ) : (
                  <div className="list">
                    {artifacts.map((artifact) => (
                      <button
                        className="draft"
                        key={artifact.artifactId}
                        onClick={() => setSelected(artifact.artifactId)}
                      >
                        <strong>{artifact.title}</strong>
                        <span> · {terms.document}</span>
                        <small> · Updated {new Date(artifact.updatedAt).toLocaleDateString()}</small>
                      </button>
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

function Onboarding({
  onSkip,
  onSave,
}: {
  onSkip: () => void;
  onSave: (baseUrl: string, model: string, key: string) => Promise<void>;
}) {
  const [step, setStep] = useState(0),
    [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1"),
    [model, setModel] = useState(""),
    [key, setKey] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  return (
    <Card>
      <CardBody>
        {step === 0 ? (
          <>
            <p className="eyebrow">Welcome</p>
            <h2>Think together, one comment at a time.</h2>
            <p>VibeCab keeps your drafts and conversations in one private workspace.</p>
            <Button onClick={() => setStep(1)}>Get started</Button>
          </>
        ) : (
          <>
            <p className="eyebrow">Model setup · optional</p>
            <h2>Add a model</h2>
            <div className="form">
              <label>
                Base URL
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
              </label>
              <label>
                Model name
                <input value={model} onChange={(event) => setModel(event.target.value)} />
              </label>
              <label>
                API key
                <input type="password" value={key} onChange={(event) => setKey(event.target.value)} />
              </label>
            </div>
            {error ? <p role="alert">{error}</p> : null}
            <p className="notice">Daily spending limits can be set later in Settings.</p>
            <p className="notice">
              Connection testing is not available yet. You can still save the model and try it later.
            </p>
            <div className="row">
              <Button variant="secondary" onClick={onSkip}>
                Skip for now
              </Button>
              <Button
                disabled={!model || !key || saving}
                onClick={() => {
                  setSaving(true);
                  void onSave(baseUrl, model, key)
                    .catch((reason) => setError(String(reason)))
                    .finally(() => {
                      setKey("");
                      setSaving(false);
                    });
                }}
              >
                {saving ? <Spinner size="sm" /> : "Save and continue"}
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
