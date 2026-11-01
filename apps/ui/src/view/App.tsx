import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Button } from "@wei/design-system";
import { Sidebar } from "./Sidebar.js";
import { WindowDragRegion } from "./WindowDragRegion.js";
import type {
  Settings,
  VcArtifactsOperation,
  VcIdeasOperation,
  VcProjectsOperation,
  VcSessionsOperation,
} from "../../../../contract/generated/index.js";
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
import { RenameDialog } from "./RenameDialog.js";
import type { RenameTarget } from "./RenameDialog.js";
import { PanelResizeHandle } from "./PanelResizeHandle.js";
import { useWorkspaceSidebar } from "./usePanelWidth.js";
import { HomeView } from "./HomeView.js";
import { IdeasView } from "./IdeasView.js";
import { ProjectsView } from "./ProjectsView.js";
import { SessionsView } from "./SessionsView.js";
import { HelpView } from "./HelpView.js";
import { DraftsView } from "./DraftsView.js";

export function App() {
  const [state, setState] = useState<ConnectionState>("Starting"),
    [artifacts, setArtifacts] = useState<VcArtifactsOperation["result"]>([]),
    [sessions, setSessions] = useState<VcSessionsOperation["result"]>([]),
    [ideas, setIdeas] = useState<VcIdeasOperation["result"]>([]),
    [projects, setProjects] = useState<VcProjectsOperation["result"]>([]),
    [error, setError] = useState(""),
    [attention, setAttention] = useState<AttentionItem[]>([]),
    [filter, setFilter] = useState(""),
    [undoTarget, setUndoTarget] = useState<
      { kind: "artifact" | "session"; id: string; reviewCount: number } | undefined
    >(),
    [draftSessionId, setDraftSessionId] = useState("none"),
    [onboarding, setOnboarding] = useState(false),
    [selected, setSelected] = useState(""),
    [projectToOpen, setProjectToOpen] = useState<string>(),
    [route, setRoute] = useState(window.location.hash.slice(1) || "/"),
    [showNewDraft, setShowNewDraft] = useState(false),
    [renameTarget, setRenameTarget] = useState<RenameTarget>(),
    [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const sidebar = useWorkspaceSidebar();
  const setConnection = (event: ConnectionEvent) => setState((current) => connectionTransition(current, event));
  const refresh = async () => {
    try {
      const [nextArtifacts, nextSessions, nextIdeas, nextProjects, nextAttention] = await Promise.all([
        listArtifacts(),
        listSessions(),
        window.vibecab.query<VcIdeasOperation["result"]>("vc.Ideas", {}),
        window.vibecab.query<VcProjectsOperation["result"]>("vc.Projects", {}),
        window.vibecab.query<AttentionItem[]>("vc.AttentionInbox", {}),
      ]);
      nextArtifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setArtifacts(nextArtifacts);
      setSessions(nextSessions);
      setIdeas(nextIdeas);
      setProjects(nextProjects);
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
      if (targetSessionId !== "none") {
        const sessionId =
          targetSessionId === "new" ? (await startSession(title ?? "New session")).sessionId : targetSessionId;
        await attachArtifact(sessionId, record.artifactId);
        setSelected("");
        window.location.hash = "/s/" + encodeURIComponent(sessionId);
      } else {
        setSelected(record.artifactId);
        window.location.hash = "/drafts";
      }
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not create draft.");
    }
  };
  const importMarkdown = async () => {
    const file = await window.vibecab.app.openMarkdown();
    if (file) await createDraft(file.content, file.name.replace(/\.md$/i, ""));
  };
  const saveRename = async (title: string) => {
    if (!renameTarget) return;
    try {
      const result =
        renameTarget.kind === "artifact"
          ? await window.vibecab.command("vc.RenameArtifact", { artifactId: renameTarget.id, title })
          : await window.vibecab.command("vc.RenameSession", { sessionId: renameTarget.id, title });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setRenameTarget(undefined);
      setError("");
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not rename.");
    }
  };
  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selected);
  const activeSessionId = route.match(/^\/s\/([^/]+)$/)?.[1],
    activeSession = sessions.find((session) => session.sessionId === decodeURIComponent(activeSessionId ?? ""));
  const groupedAttention = new Map<string, AttentionItem[]>();
  for (const item of attention) {
    const group = item.sessionId ?? "general";
    groupedAttention.set(group, [...(groupedAttention.get(group) ?? []), item]);
  }
  const needsYou = (sessionId: string) => attention.filter((item) => item.sessionId === sessionId).length;
  const filteredArtifacts = artifacts.filter((artifact) => artifact.title.toLowerCase().includes(filter.toLowerCase()));
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
  const navigateTo = (path: string) => {
    setSelected("");
    window.location.hash = path;
  };
  return (
    <div
      className="shell"
      style={{ "--workspace-sidebar-width": `${sidebar.collapsed ? 64 : sidebar.width}px` } as CSSProperties}
    >
      <WindowDragRegion />
      <Sidebar
        artifactsCount={artifacts.length}
        ideasCount={ideas.length}
        projectsCount={projects.length}
        sessions={sessions}
        activeSessionId={activeSession?.sessionId}
        route={route}
        state={state}
        theme={theme}
        setTheme={setTheme}
        needsYou={needsYou}
        onSelectNone={() => setSelected("")}
        onNavigate={navigateTo}
        onConnected={() => setConnection("connected")}
        onRefresh={refresh}
        onError={setError}
        onTrashed={(target, reviewCount) => setUndoTarget({ ...target, reviewCount })}
        onRename={(sessionId, title) => setRenameTarget({ kind: "session", id: sessionId, title })}
        collapsed={sidebar.collapsed}
        onToggleCollapsed={sidebar.toggle}
      />
      {!sidebar.collapsed ? (
        <PanelResizeHandle
          label="workspace sidebar"
          value={sidebar.width}
          min={200}
          max={360}
          onChange={sidebar.setWidth}
        />
      ) : (
        <div className="sidebar-resize-placeholder" />
      )}
      <main className={`main${activeSession ? " session-main" : ""}`}>
        {onboarding ? (
          <Onboarding
            onSkip={() => {
              setOnboarding(false);
            }}
            onSave={async (baseUrl, model, key) => {
              await window.vibecab.app.saveProvider(baseUrl, model, key);
              setOnboarding(false);
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
        ) : route === "/help" ? (
          <HelpView
            onBack={() => navigateTo("/")}
            onIdeas={() => navigateTo("/ideas")}
            onDrafts={() => navigateTo("/drafts")}
          />
        ) : route === "/ideas" ? (
          <IdeasView
            onStarted={(sessionId) => navigateTo("/s/" + encodeURIComponent(sessionId))}
            onRefresh={() => void refresh()}
          />
        ) : route === "/projects" ? (
          <ProjectsView
            projects={projects}
            drafts={artifacts}
            sessions={sessions}
            onRefresh={refresh}
            onOpenDraft={openArtifact}
            onOpenSession={(sessionId) => navigateTo("/s/" + encodeURIComponent(sessionId))}
            initialProjectId={projectToOpen}
          />
        ) : route === "/sessions" ? (
          <SessionsView sessions={sessions} onOpen={(sessionId) => navigateTo("/s/" + encodeURIComponent(sessionId))} />
        ) : route === "/" ? (
          <HomeView
            drafts={artifacts}
            sessions={sessions}
            onImprove={() => navigateTo("/drafts")}
            onExplore={() => navigateTo("/ideas")}
            onOpenSession={(sessionId) => navigateTo("/s/" + encodeURIComponent(sessionId))}
          />
        ) : selectedArtifact ? (
          <div className="page">
            <header className="page-header">
              <div>
                <p className="eyebrow">{terms.draft}</p>
                <h2 className="page-title">{selectedArtifact.title}</h2>
                <p className="meta">
                  {terms.document} · v{selectedArtifact.headVersion}
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
                  Start a {terms.session.toLowerCase()}
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
            onCreateProject={() => {
              void window.vibecab
                .command("vc.CreateProject", {
                  title: activeSession.title,
                  ideaIds: activeSession.ideaIds ?? [],
                  artifactIds: activeSession.artifactIds,
                  sessionIds: [activeSession.sessionId],
                  sourceSessionIds: [activeSession.sessionId],
                })
                .then(async (result) => {
                  if (!result.ok) {
                    setError(result.error.message);
                    return;
                  }
                  const id =
                    typeof result.result === "object" && result.result !== null
                      ? Reflect.get(result.result, "projectId")
                      : undefined;
                  if (typeof id !== "string") return;
                  setProjectToOpen(id);
                  await refresh();
                  navigateTo("/projects");
                })
                .catch((failure) => setError(failure instanceof Error ? failure.message : "Could not create Project."));
            }}
          />
        ) : (
          <DraftsView
            artifacts={artifacts}
            filteredArtifacts={filteredArtifacts}
            sessions={sessions}
            groupedAttention={groupedAttention}
            filter={filter}
            setFilter={setFilter}
            showNewDraft={showNewDraft}
            setShowNewDraft={setShowNewDraft}
            draftSessionId={draftSessionId}
            setDraftSessionId={setDraftSessionId}
            error={error}
            homeMeta={homeMeta}
            undoTarget={undoTarget}
            onCreateDraft={() => void createDraft()}
            onImport={() => void importMarkdown()}
            onNewSession={() =>
              void startSession("New session")
                .then(({ sessionId }) => navigateTo("/s/" + encodeURIComponent(sessionId)))
                .catch((failure) => setError(String(failure)))
            }
            onOpenArtifact={openArtifact}
            onRename={(draft) => setRenameTarget({ kind: "artifact", id: draft.artifactId, title: draft.title })}
            onTrash={(artifactId) => {
              const target = { kind: "artifact" as const, id: artifactId };
              void window.vibecab
                .query<{ reviewRuns: unknown[] }>("vc.PurgePreview", { target })
                .then((preview) =>
                  window.vibecab.command("vc.Trash", { target }).then((result) => ({ preview, result })),
                )
                .then(({ preview, result }) => {
                  if (!result.ok) return;
                  setUndoTarget({ ...target, reviewCount: preview.reviewRuns.length });
                  return refresh();
                });
            }}
            onUndo={() => {
              if (!undoTarget) return;
              void window.vibecab
                .command("vc.Restore", { target: { kind: undoTarget.kind, id: undoTarget.id } })
                .then(refresh);
              setUndoTarget(undefined);
            }}
          />
        )}
      </main>
      {renameTarget ? (
        <RenameDialog title={renameTarget.title} onCancel={() => setRenameTarget(undefined)} onSave={saveRename} />
      ) : null}
    </div>
  );
}
