import { useState } from "react";
import { Glider } from "../ui/Glider.js";
import { Button, Icon } from "@wei/design-system";
import type { Idea, Project } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";
import { useLiveQuery } from "../live/LiveStore.js";
import type { DraftRow, SessionRow } from "../live/workspace.js";
import { Hills } from "../ui/Brand.js";
import { Menu } from "../ui/Menu.js";
import { plural, relativeTime } from "../ui/time.js";
import { PageSkeleton } from "./Views.js";
import {
  Capture,
  CheckDialog,
  IdeaRow,
  MakeDraftDialog,
  NewProjectDialog,
  PickDialog,
  SelectionBar,
  draftWord,
  ideaWord,
  kindWords,
  projectWord,
  sessionWord,
  useIdeaActions,
} from "./ideaParts.js";
import type { ItemKind } from "./ideaParts.js";
import { IdeaSky, canDrawSky } from "./IdeaSky.js";
import { useIdeasView } from "../shell/prefs.js";

export { markdownFromIdeas, titleFromIdeas } from "./ideaParts.js";

/** Every Idea. `bare` is the same page as a tab of Home: no header of its own. */
export function IdeasView({ sessions, bare = false }: { sessions: SessionRow[]; bare?: boolean }) {
  const ideas = useLiveQuery<Idea[]>("vc.Ideas", {}),
    projects = useLiveQuery<Project[]>("vc.Projects", {}),
    act = useIdeaActions(),
    [selected, setSelected] = useState<string[]>([]),
    [group, setGroup] = useState<"newest" | "project">("newest"),
    [drafting, setDrafting] = useState<Idea[]>(),
    [adding, setAdding] = useState<Idea[]>(),
    [gathering, setGathering] = useState<Idea[]>(),
    [view, setView] = useIdeasView();
  const sessionTitle = new Map(sessions.map((s) => [s.sessionId, s.title])),
    projectList = projects.data ?? [],
    projectTitle = new Map(projectList.map((p) => [p.projectId, p.title]));
  if (ideas.loading) return <PageSkeleton />;
  const list = [...(ideas.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    chosen = list.filter((i) => selected.includes(i.ideaId));
  const where = (idea: Idea) => {
    const places = [
      ...(idea.projectIds ?? []).map((id) => projectTitle.get(id)).filter(Boolean),
      ...(idea.sessionIds ?? []).map((id) => sessionTitle.get(id)).filter(Boolean),
    ];
    return places.length ? "In " + places.join(", ") : "Not used yet";
  };
  // The sky needs a few stars to be a sky, and a browser that can draw; otherwise the list is all there is.
  const skyOffered = list.length >= 3 && canDrawSky(),
    sky = skyOffered && view === "sky";
  const row = (idea: Idea) => (
    <IdeaRow
      key={idea.ideaId}
      idea={idea}
      where={where(idea)}
      selected={selected.includes(idea.ideaId)}
      onSelect={(on) => setSelected((now) => (on ? [...now, idea.ideaId] : now.filter((id) => id !== idea.ideaId)))}
      menu={
        <Menu
          label={`Actions for ${ideaWord}`}
          items={[
            { label: `Make a ${draftWord}`, onSelect: () => setDrafting([idea]) },
            { label: `Add to a ${projectWord}`, onSelect: () => setAdding([idea]) },
            {
              label: "Move to Trash",
              tone: "danger",
              separatorBefore: true,
              onSelect: () => act.trash([idea]),
            },
          ]}
        />
      }
    />
  );
  // Grouped by project: each project's ideas, then the ones in none. An idea in two projects shows twice.
  const groups =
    group === "project"
      ? [
          ...projectList
            .map((p) => ({
              key: p.projectId,
              title: p.title,
              ideas: list.filter((i) => i.projectIds?.includes(p.projectId)),
            }))
            .filter((g) => g.ideas.length),
          { key: "none", title: `Not in a ${projectWord}`, ideas: list.filter((i) => !i.projectIds?.length) },
        ].filter((g) => g.ideas.length)
      : [{ key: "all", title: "", ideas: list }];
  return (
    <div className={bare ? undefined : "vc-page"}>
      {!bare && (
        <header className="vc-header">
          <h1 className="vc-display">{terms.idea}s</h1>
          <p className="vc-facts">
            {list.length ? plural(list.length, ideaWord) : "Save ideas here before you forget them."}
          </p>
        </header>
      )}
      <Capture
        label={`Type an ${ideaWord}. Press ↩ to save it.`}
        onSave={async (text) => (await act.run("vc.CaptureIdea", { text })) !== undefined}
      />
      {list.length > 0 && (
        // How to use what is shown, and how to arrange it: both about it, so both sit right above it.
        <div className="vc-list-head">
          <p className="vc-hint">
            {sky
              ? `Each ${ideaWord} is a star. Close ones are joined. Choose one to see what it is close to.`
              : `Click an ${ideaWord} to change its words. Tick a few to make a ${draftWord} or a ${projectWord} from them.`}
          </p>
          {skyOffered && (
            <div className="vc-segmented small" role="group" aria-label="Show as">
              <Glider selector='[aria-pressed="true"],[aria-current="page"]' />
              <button type="button" aria-pressed={sky} onClick={() => setView("sky")}>
                Sky
              </button>
              <button type="button" aria-pressed={!sky} onClick={() => setView("list")}>
                List
              </button>
            </div>
          )}
          {!sky && projectList.length > 0 && (
            <div className="vc-segmented small" role="group" aria-label="Arrange">
              <Glider selector='[aria-pressed="true"],[aria-current="page"]' />
              <button type="button" aria-pressed={group === "newest"} onClick={() => setGroup("newest")}>
                Newest first
              </button>
              <button type="button" aria-pressed={group === "project"} onClick={() => setGroup("project")}>
                By {projectWord}
              </button>
            </div>
          )}
        </div>
      )}
      {sky && <IdeaSky ideas={list} where={where} onGather={setGathering} onDraft={setDrafting} />}
      {!sky &&
        groups.map((g) => (
          <section key={g.key} className="vc-section" aria-label={g.title || `${terms.idea}s`}>
            {g.title && <h2 className="vc-label">{g.title}</h2>}
            <ul className="vc-list">{g.ideas.map(row)}</ul>
          </section>
        ))}
      <SelectionBar count={chosen.length} onClear={() => setSelected([])}>
        <button type="button" className="vc-bar-button labelled" onClick={() => setDrafting(chosen)}>
          Make a {draftWord}
        </button>
        <button type="button" className="vc-bar-button text" onClick={() => setAdding(chosen)}>
          Add to a {projectWord}
        </button>
        <button type="button" className="vc-bar-button text" onClick={() => setGathering(chosen)}>
          New {projectWord}
        </button>
        <button
          type="button"
          className="vc-bar-button text danger"
          onClick={() => {
            act.trash(chosen);
            setSelected([]);
          }}
        >
          Trash
        </button>
      </SelectionBar>
      <MakeDraftDialog
        ideas={drafting}
        onClose={() => {
          setDrafting(undefined);
          setSelected([]);
        }}
      />
      <PickDialog
        open={adding !== undefined}
        title={`Add to a ${projectWord}`}
        {...(adding && adding.length > 1 ? { lede: plural(adding.length, ideaWord) + "." } : {})}
        label={terms.project}
        submitLabel="Add"
        options={projectList
          .filter((p) => adding?.some((i) => !p.ideaIds?.includes(i.ideaId)))
          .map((p) => ({ id: p.projectId, title: p.title }))}
        onClose={() => setAdding(undefined)}
        onPick={async (projectId) => {
          const project = projectList.find((p) => p.projectId === projectId);
          const ids = (adding ?? []).map((i) => i.ideaId).filter((id) => !project?.ideaIds?.includes(id));
          const ok = await act.addToProject(projectId, "idea", ids);
          if (ok) setSelected([]);
          return ok;
        }}
      />
      <NewProjectDialog
        open={gathering !== undefined}
        ideas={gathering ?? []}
        onClose={() => {
          setGathering(undefined);
          setSelected([]);
        }}
      />
    </div>
  );
}

/** Every Project. `bare` is the same page as a tab of Home: no header of its own. */
export function ProjectsView({ bare = false }: { bare?: boolean }) {
  const projects = useLiveQuery<Project[]>("vc.Projects", {}),
    [creating, setCreating] = useState(false);
  if (projects.loading) return <PageSkeleton />;
  const list = [...(projects.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className={bare ? undefined : "vc-page"}>
      {bare ? (
        <div className="vc-panel-note">
          <Button variant="ghost" leadingIcon={<Icon name="plus" />} onClick={() => setCreating(true)}>
            New {projectWord}
          </Button>
        </div>
      ) : (
        <header className="vc-header">
          <h1 className="vc-display">{terms.project}s</h1>
          <p className="vc-facts">{list.length ? plural(list.length, projectWord) : "No projects."}</p>
          <div className="vc-actions">
            <Button variant="primary" leadingIcon={<Icon name="plus" />} onClick={() => setCreating(true)}>
              New {projectWord}
            </Button>
          </div>
        </header>
      )}
      {list.length === 0 && (
        <div className="vc-empty-note">
          <Hills />
          <p>
            A {projectWord} keeps the {terms.draft.toLowerCase()}s, {terms.session.toLowerCase()}s and ideas of one
            piece of work together.
          </p>
        </div>
      )}
      {list.length > 0 && (
        <section className="vc-section" aria-label={`${terms.project}s`}>
          <ul className="vc-list">
            {list.map((p) => (
              <li key={p.projectId} className="vc-row">
                <span className="lead">
                  <Icon name="briefcase" size={20} />
                </span>
                <span className="main">
                  <a className="title" href={"#/p/" + p.projectId}>
                    {p.title}
                  </a>
                  <span className="sub">
                    {[
                      plural(p.ideaIds?.length ?? 0, ideaWord),
                      plural(p.artifactIds?.length ?? 0, terms.draft),
                      plural(p.sessionIds?.length ?? 0, sessionWord),
                    ].join(" · ")}
                  </span>
                </span>
                <span className="end">
                  <span className="when">{relativeTime(p.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

export function ProjectView({
  projectId,
  sessions,
  drafts,
}: {
  projectId: string;
  sessions: SessionRow[];
  drafts: DraftRow[];
}) {
  const projects = useLiveQuery<Project[]>("vc.Projects", {}),
    ideas = useLiveQuery<Idea[]>("vc.Ideas", {}),
    act = useIdeaActions(),
    [adding, setAdding] = useState<ItemKind>(),
    [selected, setSelected] = useState<string[]>([]),
    [drafting, setDrafting] = useState<Idea[]>();
  if (projects.loading) return <PageSkeleton />;
  const project = projects.data?.find((p) => p.projectId === projectId);
  if (!project)
    return (
      <div className="vc-page">
        <h1 className="vc-display">{terms.project} not found</h1>
      </div>
    );
  const sessionTitle = new Map(sessions.map((s) => [s.sessionId, s.title]));
  const all: Record<ItemKind, Array<{ id: string; title: string; sub?: string; href?: string }>> = {
    idea: (ideas.data ?? []).map((i) => ({ id: i.ideaId, title: i.text, sub: relativeTime(i.createdAt) })),
    artifact: drafts.map((d) => {
      const home = d.sessionIds.find((id) => sessionTitle.has(id));
      return {
        id: d.artifactId,
        title: d.title,
        ...(home ? { href: `#/s/${home}/d/${d.artifactId}`, sub: "In " + sessionTitle.get(home) } : {}),
      };
    }),
    session: sessions.map((s) => ({
      id: s.sessionId,
      title: s.title,
      href: "#/s/" + s.sessionId,
      ...(s.state !== "active" ? { sub: s.state === "paused" ? terms.paused : terms.ended } : {}),
    })),
  };
  const inProject: Record<ItemKind, string[]> = {
    idea: project.ideaIds ?? [],
    artifact: project.artifactIds ?? [],
    session: project.sessionIds ?? [],
  };
  const projectIdeas = (ideas.data ?? [])
      .filter((i) => inProject.idea.includes(i.ideaId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    chosen = projectIdeas.filter((i) => selected.includes(i.ideaId));
  const detach = (kind: ItemKind, id: string) =>
    void act.run("vc.DetachProjectItem", { projectId, item: { kind, id } });
  const removeMenu = (
    kind: ItemKind,
    id: string,
    title: string,
    extra: Array<{ label: string; onSelect(): void }> = [],
  ) => (
    <Menu
      label={`Actions for ${title.slice(0, 30)}`}
      items={[...extra, { label: `Remove from ${projectWord}`, onSelect: () => detach(kind, id) }]}
    />
  );
  return (
    <div className="vc-page">
      <header className="vc-header">
        <p className="vc-label">{terms.project}</p>
        <h1 className="vc-display">{project.title}</h1>
        {project.background && <p className="vc-lede">{project.background}</p>}
      </header>
      <section className="vc-section" aria-label={`${terms.idea}s`}>
        <div className="vc-section-head">
          <h2 className="vc-label">{terms.idea}s</h2>
          <button type="button" className="vc-link-button" onClick={() => setAdding("idea")}>
            Add existing
          </button>
        </div>
        <Capture
          label={`Add a new ${ideaWord} to this ${projectWord}, then press ↩`}
          onSave={async (text) => {
            const idea = await act.run<{ ideaId: string }>("vc.CaptureIdea", { text });
            return idea !== undefined && (await act.addToProject(projectId, "idea", [idea.ideaId]));
          }}
        />
        {projectIdeas.length > 0 && (
          <ul className="vc-list">
            {projectIdeas.map((idea) => (
              <IdeaRow
                key={idea.ideaId}
                idea={idea}
                where={
                  idea.sessionIds?.length
                    ? "In " +
                      idea.sessionIds
                        .map((id) => sessionTitle.get(id))
                        .filter(Boolean)
                        .join(", ")
                    : "Not used yet"
                }
                selected={selected.includes(idea.ideaId)}
                onSelect={(on) =>
                  setSelected((now) => (on ? [...now, idea.ideaId] : now.filter((id) => id !== idea.ideaId)))
                }
                menu={removeMenu("idea", idea.ideaId, idea.text, [
                  { label: `Make a ${draftWord}`, onSelect: () => setDrafting([idea]) },
                ])}
              />
            ))}
          </ul>
        )}
      </section>
      {(["artifact", "session"] as const).map((kind) => {
        const rows = all[kind].filter((x) => inProject[kind].includes(x.id));
        return (
          <section key={kind} className="vc-section" aria-label={`${kindWords[kind]}s`}>
            <div className="vc-section-head">
              <h2 className="vc-label">{kindWords[kind]}s</h2>
              <button type="button" className="vc-link-button" onClick={() => setAdding(kind)}>
                Add
              </button>
            </div>
            {rows.length ? (
              <ul className="vc-list">
                {rows.map((row) => (
                  <li key={row.id} className="vc-row">
                    <span className="lead">
                      <Icon name={kind === "artifact" ? "document-text" : "chevron-right"} size={16} />
                    </span>
                    <span className="main">
                      {row.href ? (
                        <a className="title" href={row.href}>
                          {row.title}
                        </a>
                      ) : (
                        <span className="title static wrap">{row.title}</span>
                      )}
                      {row.sub && <span className="sub">{row.sub}</span>}
                    </span>
                    <span className="end">{removeMenu(kind, row.id, row.title)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="vc-muted small">None yet.</p>
            )}
          </section>
        );
      })}
      <SelectionBar count={chosen.length} onClear={() => setSelected([])}>
        <button type="button" className="vc-bar-button labelled" onClick={() => setDrafting(chosen)}>
          Make a {draftWord}
        </button>
        <button
          type="button"
          className="vc-bar-button text"
          onClick={() => {
            for (const idea of chosen) detach("idea", idea.ideaId);
            setSelected([]);
          }}
        >
          Remove from {projectWord}
        </button>
      </SelectionBar>
      <MakeDraftDialog
        ideas={drafting}
        onClose={() => {
          setDrafting(undefined);
          setSelected([]);
        }}
      />
      <CheckDialog
        open={adding !== undefined}
        title={`Add ${adding ? kindWords[adding].toLowerCase() : ""}s`}
        empty={`Everything is in this ${projectWord} already.`}
        options={adding ? all[adding].filter((x) => !inProject[adding].includes(x.id)) : []}
        onClose={() => setAdding(undefined)}
        onAdd={(ids) => (adding ? act.addToProject(projectId, adding, ids) : Promise.resolve(false))}
      />
    </div>
  );
}
