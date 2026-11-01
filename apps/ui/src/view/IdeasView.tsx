import { useEffect, useState } from "react";
import { Button } from "@wei/design-system";
import type { VcIdeasOperation } from "../../../../contract/generated/index.js";
import { startSession } from "../api/sessions.js";
import { terms } from "../copy/terms.js";

type Idea = VcIdeasOperation["result"][number];

export function IdeasView({ onStarted, onRefresh }: { onStarted: (sessionId: string) => void; onRefresh: () => void }) {
  const [ideas, setIdeas] = useState<Idea[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [text, setText] = useState(""),
    [error, setError] = useState("");
  const load = async () => {
    try {
      setIdeas(await window.vibecab.query<Idea[]>("vc.Ideas", {}));
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load Ideas.");
    }
  };
  useEffect(() => void load(), []);
  const capture = async () => {
    const result = await window.vibecab.command("vc.CaptureIdea", { text: text.trim() });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setText("");
    await load();
    onRefresh();
  };
  const begin = async () => {
    try {
      const { sessionId } = await startSession(selected.length ? "Explore Ideas" : "Idea Session", {
        ideaIds: selected,
      });
      onStarted(sessionId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the Session.");
    }
  };
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Your starting points</p>
          <h1 className="page-title">{terms.idea}s</h1>
          <p className="meta">Ideas stay here while you explore them in Sessions or grow them into Projects.</p>
        </div>
        <div className="page-actions">
          <Button variant="primary" onClick={() => void begin()}>
            {selected.length
              ? `Start a Session with ${selected.length} ${terms.idea.toLowerCase()}${selected.length === 1 ? "" : "s"}`
              : "Start a Session"}
          </Button>
        </div>
      </header>
      <section className="panel idea-capture">
        <label className="field">
          <span>Capture an Idea</span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="A thought to come back to…"
          />
        </label>
        <Button variant="secondary" disabled={!text.trim()} onClick={() => void capture()}>
          Save Idea
        </Button>
      </section>
      {error ? (
        <p role="alert" className="notice">
          {error}
        </p>
      ) : null}
      {ideas.length ? (
        <div className="idea-list">
          {ideas.map((idea) => (
            <label className="idea-row" key={idea.ideaId}>
              <input
                type="checkbox"
                checked={selected.includes(idea.ideaId)}
                onChange={() =>
                  setSelected((current) =>
                    current.includes(idea.ideaId)
                      ? current.filter((id) => id !== idea.ideaId)
                      : [...current, idea.ideaId],
                  )
                }
              />
              <span className="idea-text">{idea.text}</span>
              <small className="meta">
                {idea.sessionIds?.length ? `${idea.sessionIds.length} Sessions` : "Not explored yet"}
                {idea.projectIds?.length ? ` · ${idea.projectIds.length} Projects` : ""}
              </small>
            </label>
          ))}
        </div>
      ) : (
        <section className="empty-state compact-empty">
          <h2>No Ideas yet</h2>
          <p>Capture a thought now. You can gather Ideas into a Session whenever you’re ready.</p>
        </section>
      )}
    </div>
  );
}
