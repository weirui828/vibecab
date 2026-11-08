import { useState } from "react";
import { Button } from "@wei/design-system";
import { terms } from "../../../ui/src/copy/terms.js";
import { sortSessions } from "../live/workspace.js";
import type { SessionRow, useWorkspace } from "../live/workspace.js";
import { plural } from "../ui/time.js";
import { SessionRows } from "./Rows.js";
import { useDialogs } from "./DialogHost.js";
import { PageSkeleton } from "./Views.js";

type Show = "all" | SessionRow["state"];
const heading: Record<SessionRow["state"], string> = { active: terms.active, paused: terms.paused, ended: terms.ended };
const blurb: Record<SessionRow["state"], string> = {
  active: "The agent replies and Updates run.",
  paused: "Kept as they are until you resume them.",
  ended: `Read-only records. Carry one on in a new ${terms.session.toLowerCase()} from its menu.`,
};

/** Every session, by state: where paused and ended ones are found. */
export function SessionsView({
  workspace,
  show: initial = "all",
}: {
  workspace: ReturnType<typeof useWorkspace>;
  show?: Show;
}) {
  const dialogs = useDialogs(),
    [show, setShow] = useState<Show>(initial);
  if (workspace.loading && !workspace.sessions) return <PageSkeleton />;
  const sessions = sortSessions(workspace.sessions ?? [], workspace.attention),
    count = (state: SessionRow["state"]) => sessions.filter((s) => s.state === state).length;
  const states = (["active", "paused", "ended"] as const).filter((state) => show === "all" || show === state);
  return (
    <div className="vc-page">
      <header className="vc-header">
        <h1 className="vc-display">{terms.session}s</h1>
        <p className="vc-facts">
          {[
            plural(count("active"), terms.active.toLowerCase()),
            plural(count("paused"), terms.paused.toLowerCase()),
            plural(count("ended"), terms.ended.toLowerCase()),
          ].join(" · ")}
        </p>
        <div className="vc-actions">
          <div className="vc-segmented small" role="group" aria-label="Show">
            {(["all", "active", "paused", "ended"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={show === value} onClick={() => setShow(value)}>
                {value === "all" ? "All" : heading[value]}
              </button>
            ))}
          </div>
          <Button variant="ghost" onClick={dialogs.newSession}>
            New {terms.session.toLowerCase()}
          </Button>
        </div>
      </header>
      {states.map((state) => {
        const list = sessions.filter((s) => s.state === state);
        return (
          <section key={state} className="vc-section" aria-labelledby={"sessions-" + state}>
            <div className="vc-section-head">
              <h2 className="vc-label" id={"sessions-" + state}>
                {heading[state]}
              </h2>
            </div>
            <p className="vc-hint" style={{ marginTop: 0 }}>
              {blurb[state]}
            </p>
            {list.length ? (
              <SessionRows sessions={list} drafts={workspace.drafts ?? []} attention={workspace.attention} />
            ) : (
              <p className="vc-muted small">None.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
