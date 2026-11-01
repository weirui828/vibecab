import { useEffect, useState } from "react";
import { Button } from "@wei/design-system";
import type {
  VcArtifactsOperation,
  VcProjectsOperation,
  VcSessionsOperation,
} from "../../../../contract/generated/index.js";
import { startSession } from "../api/sessions.js";
import { terms } from "../copy/terms.js";

type Draft = VcArtifactsOperation["result"][number];
type Session = VcSessionsOperation["result"][number];
type ProjectRecord = VcProjectsOperation["result"][number];

export function ProjectsView({
  projects,
  drafts,
  sessions,
  onRefresh,
  onOpenDraft,
  onOpenSession,
  initialProjectId,
}: {
  projects: ProjectRecord[];
  drafts: Draft[];
  sessions: Session[];
  onRefresh: () => Promise<void>;
  onOpenDraft: (artifactId: string) => void;
  onOpenSession: (sessionId: string) => void;
  initialProjectId?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(initialProjectId),
    [title, setTitle] = useState(""),
    [error, setError] = useState(""),
    [availableIdeas, setAvailableIdeas] = useState<Array<{ ideaId: string; text: string }>>([]);
  const selected = projects.find((project) => project.projectId === selectedId);
  useEffect(() => {
    if (initialProjectId) setSelectedId(initialProjectId);
  }, [initialProjectId]);
  useEffect(() => {
    void window.vibecab.query<Array<{ ideaId: string; text: string }>>("vc.Ideas", {}).then(setAvailableIdeas);
  }, []);
  const create = async () => {
    const result = await window.vibecab.command("vc.CreateProject", { title: title.trim() });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    const projectId =
      typeof result.result === "object" && result.result !== null ? Reflect.get(result.result, "projectId") : undefined;
    if (typeof projectId !== "string") {
      setError("Could not open the new Project.");
      return;
    }
    setTitle("");
    await onRefresh();
    setSelectedId(projectId);
  };
  const attach = async (kind: "idea" | "artifact" | "session", id: string) => {
    if (!selected || !id) return;
    const result = await window.vibecab.command("vc.AttachProjectItem", {
      projectId: selected.projectId,
      item: { kind, id },
    });
    if (!result.ok) setError(result.error.message);
    else {
      setError("");
      await onRefresh();
    }
  };
  const detach = async (kind: "idea" | "artifact" | "session", id: string) => {
    if (!selected) return;
    const result = await window.vibecab.command("vc.DetachProjectItem", {
      projectId: selected.projectId,
      item: { kind, id },
    });
    if (!result.ok) setError(result.error.message);
    else {
      setError("");
      await onRefresh();
    }
  };
  const newSession = async () => {
    if (!selected) return;
    try {
      const { sessionId } = await startSession(selected.title, {
        primaryProjectId: selected.projectId,
        ideaIds: selected.ideaIds,
      });
      await onRefresh();
      onOpenSession(sessionId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the Session.");
    }
  };
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Longer-running work</p>
          <h1 className="page-title">{terms.project}s</h1>
          <p className="meta">
            Projects group related {terms.idea.toLowerCase()}s, {terms.draft.toLowerCase()}s, and{" "}
            {terms.session.toLowerCase()}s. They’re optional.
          </p>
        </div>
      </header>
      {error ? (
        <p role="alert" className="notice">
          {error}
        </p>
      ) : null}
      <div className="project-layout">
        <section className="project-list" aria-label="Projects">
          <div className="project-create">
            <label className="field">
              <span>New Project</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Project name" />
            </label>
            <Button variant="primary" disabled={!title.trim()} onClick={() => void create()}>
              Create
            </Button>
          </div>
          {projects.length ? (
            projects.map((project) => (
              <button
                key={project.projectId}
                className="project-list-item"
                aria-current={project.projectId === selectedId ? "true" : undefined}
                onClick={() => {
                  setSelectedId(project.projectId);
                }}
              >
                <strong>{project.title}</strong>
                <span className="meta">
                  {project.artifactIds?.length ?? 0} {terms.draft.toLowerCase()}s · {project.sessionIds?.length ?? 0}{" "}
                  {terms.session.toLowerCase()}s
                </span>
              </button>
            ))
          ) : (
            <p className="quiet">No Projects yet. Create one when you have a direction to pursue.</p>
          )}
        </section>
        {selected ? (
          <section className="project-detail" aria-label={selected.title}>
            <div className="project-detail-header">
              <div>
                <p className="eyebrow">{terms.project}</p>
                <h2>{selected.title}</h2>
                {selected.background ? <p className="meta">{selected.background}</p> : null}
              </div>
              <Button variant="primary" onClick={() => void newSession()}>
                Start a Session
              </Button>
            </div>
            <ProjectItems title={`${terms.draft}s`}>
              {selected.artifactIds?.length ? (
                selected.artifactIds.map((id) => {
                  const draft = drafts.find((item) => item.artifactId === id);
                  return (
                    <div className="project-item-row" key={id}>
                      <button className="project-item-link" onClick={() => onOpenDraft(id)}>
                        {draft?.title ?? "Draft unavailable"}
                      </button>
                      <button className="quiet-action" onClick={() => void detach("artifact", id)}>
                        Remove
                      </button>
                    </div>
                  );
                })
              ) : (
                <p className="quiet">Nothing added yet.</p>
              )}
            </ProjectItems>
            <div className="project-add-row">
              <select
                aria-label="Add a Draft to this Project"
                value=""
                onChange={(event) => void attach("artifact", event.target.value)}
              >
                <option value="">Add a Draft…</option>
                {drafts
                  .filter((draft) => !selected.artifactIds?.includes(draft.artifactId))
                  .map((draft) => (
                    <option key={draft.artifactId} value={draft.artifactId}>
                      {draft.title}
                    </option>
                  ))}
              </select>
            </div>
            <ProjectItems title={`${terms.session}s`}>
              {selected.sessionIds?.length ? (
                selected.sessionIds.map((id) => {
                  const session = sessions.find((item) => item.sessionId === id);
                  return (
                    <div className="project-item-row" key={id}>
                      <button className="project-item-link" onClick={() => onOpenSession(id)}>
                        {session ? `${session.title} · ${terms[session.state]}` : "Session unavailable"}
                      </button>
                      <button className="quiet-action" onClick={() => void detach("session", id)}>
                        Remove
                      </button>
                    </div>
                  );
                })
              ) : (
                <p className="quiet">Nothing added yet.</p>
              )}
            </ProjectItems>
            <div className="project-add-row">
              <select
                aria-label="Add a Session to this Project"
                value=""
                onChange={(event) => void attach("session", event.target.value)}
              >
                <option value="">Add a Session…</option>
                {sessions
                  .filter((session) => !selected.sessionIds?.includes(session.sessionId))
                  .map((session) => (
                    <option key={session.sessionId} value={session.sessionId}>
                      {session.title}
                    </option>
                  ))}
              </select>
            </div>
            <ProjectItems title={`${terms.idea}s`}>
              {selected.ideaIds?.length ? (
                selected.ideaIds.map((id) => {
                  const idea = availableIdeas.find((item) => item.ideaId === id);
                  return (
                    <div className="project-item-row" key={id}>
                      <span className="project-item-link">{idea?.text ?? "Idea unavailable"}</span>
                      <button className="quiet-action" onClick={() => void detach("idea", id)}>
                        Remove
                      </button>
                    </div>
                  );
                })
              ) : (
                <p className="quiet">Nothing added yet.</p>
              )}
            </ProjectItems>
            <div className="project-add-row">
              <select
                aria-label="Add an Idea to this Project"
                value=""
                onChange={(event) => void attach("idea", event.target.value)}
              >
                <option value="">Add an Idea…</option>
                {availableIdeas
                  .filter((idea) => !selected.ideaIds?.includes(idea.ideaId))
                  .map((idea) => (
                    <option key={idea.ideaId} value={idea.ideaId}>
                      {idea.text}
                    </option>
                  ))}
              </select>
            </div>
            {selected.sourceSessionIds?.length ? (
              <section className="project-items">
                <h3>Started from</h3>
                {selected.sourceSessionIds.map((id) => {
                  const source = sessions.find((item) => item.sessionId === id);
                  return source ? (
                    <button className="project-item-link" key={id} onClick={() => onOpenSession(id)}>
                      {source.title}
                    </button>
                  ) : null;
                })}
              </section>
            ) : null}
          </section>
        ) : (
          <section className="empty-state compact-empty project-placeholder">
            <h2>Projects are optional</h2>
            <p>Choose a Project to see its Drafts and Sessions, or create one when you’re ready to keep building.</p>
          </section>
        )}
      </div>
    </div>
  );
}

function ProjectItems({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="project-items">
      <h3>{title}</h3>
      <div className="project-items-list">{children}</div>
    </section>
  );
}
