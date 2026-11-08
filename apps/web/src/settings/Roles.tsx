import { useState } from "react";
import { Button, Field, Input } from "@wei/design-system";
import { terms } from "../../../ui/src/copy/terms.js";
import type { SessionRow } from "../live/workspace.js";
import { sessionAgent } from "../session/loop.js";
import { GrantsSection, ToolsSection } from "./AccessSections.js";
import { nameOf, runsOn } from "./AgentPool.js";
import { AgentGroup, Section, dollars, toMicros, useRun } from "./common.js";
import type { SettingsShape } from "./ModelForm.js";
import type { ReactNode } from "react";

// W13: roles assign pool agents to work. VibeCab has one agent (it needs tools); TMR has a panel of 2–7.

type Member = { agentId: string; label?: string };
const MIN_PANEL = 2,
  MAX_PANEL = 7;

/** Which agent works for VibeCab: any pool agent that can use tools. */
function VibecabAgent({ settings }: { settings: SettingsShape }) {
  const run = useRun(),
    models = settings.models ?? {},
    eligible = Object.keys(models).filter((id) => models[id]?.capabilities.tools),
    // What the engine uses now, even before a role is set.
    current = sessionAgent(settings, "default");
  if (!eligible.length)
    return <p className="vc-muted">Add an agent that can use tools in Agents. Then choose it here.</p>;
  return (
    <Field label="Agent" hint={`A ${terms.session.toLowerCase()} can choose another agent in its Agent panel.`}>
      <select
        className="vc-select"
        aria-label="Agent for VibeCab"
        value={current ?? ""}
        onChange={(e) => void run("sys.SetSettings", { patch: { roles: { vibecab: e.target.value } } })}
      >
        {eligible.map((id) => (
          <option key={id} value={id}>
            {nameOf(id, models[id])}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** The TMR panel: who sits on it, under which label, the process, and what one run may spend. */
function TmrPanel({ settings }: { settings: SettingsShape }) {
  const run = useRun(),
    models = settings.models ?? {},
    // TMR asks each agent for structured answers.
    eligible = Object.keys(models).filter((id) => models[id]?.capabilities.jsonSchemaOutput),
    saved = settings.roles?.tmr,
    [panel, setPanel] = useState<Member[]>(saved?.panel ?? []),
    [cap, setCap] = useState(saved?.spendMicros !== undefined ? dollars(saved.spendMicros) : "1.00"),
    [error, setError] = useState<string>();
  const on = (id: string) => panel.find((m) => m.agentId === id);
  const toggle = (id: string) =>
    setPanel((now) => (on(id) ? now.filter((m) => m.agentId !== id) : [...now, { agentId: id }]));
  const label = (id: string, value: string) =>
    setPanel((now) => now.map((m) => (m.agentId === id ? { ...m, label: value } : m)));
  // Two members on one model with no instructions give the same answer twice: say so.
  const twins = panel.filter((m, i) => {
    const a = models[m.agentId];
    return (
      a &&
      !a.instructions &&
      panel.some((n, j) => {
        const b = models[n.agentId];
        return j !== i && b && !b.instructions && b.provider === a.provider && b.model === a.model;
      })
    );
  });
  async function save() {
    setError(undefined);
    if (panel.length < MIN_PANEL) return setError(`Choose at least ${MIN_PANEL} agents.`);
    if (panel.length > MAX_PANEL) return setError(`Choose ${MAX_PANEL} agents or fewer.`);
    const spendMicros = toMicros(cap);
    if (!spendMicros) return setError("Type the most one run may spend, in dollars, like 1.50.");
    const members = panel.map((m) => ({ agentId: m.agentId, ...(m.label?.trim() ? { label: m.label.trim() } : {}) }));
    await run("sys.SetSettings", {
      patch: { roles: { tmr: { panel: members, process: "independent-review", spendMicros } } },
    });
  }
  if (eligible.length < MIN_PANEL)
    return (
      <p className="vc-muted">
        A panel needs at least {MIN_PANEL} agents that give structured answers. Add them in Agents.
      </p>
    );
  return (
    <form
      className="vc-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset className="vc-panel-members">
        <legend className="vc-label">
          Panel ({panel.length} of {MIN_PANEL}–{MAX_PANEL})
        </legend>
        {eligible.map((id) => {
          const member = on(id),
            name = nameOf(id, models[id]);
          return (
            <div key={id} className="vc-panel-member">
              <label className="vc-panel-check">
                <input type="checkbox" checked={Boolean(member)} onChange={() => toggle(id)} />
                <span>
                  {name}
                  <span className="vc-facts">{runsOn(models[id]!)}</span>
                </span>
              </label>
              {member && (
                <Field label={`${name}: role on the panel`} hideLabel>
                  <Input
                    placeholder={`Role, for example “Skeptic” (else “${name}”)`}
                    value={member.label ?? ""}
                    onChange={(e) => label(id, e.target.value)}
                  />
                </Field>
              )}
            </div>
          );
        })}
      </fieldset>
      {twins.length > 0 && (
        <p className="vc-warning" role="status">
          {twins.map((m) => nameOf(m.agentId, models[m.agentId])).join(" and ")} use the same model with no
          instructions, so they will probably give the same answer. Give them instructions in Agents, or choose another
          model.
        </p>
      )}
      <div className="vc-form-row">
        <Field label="Process" hint="Each agent reviews alone. Then the first agent on the panel writes the summary.">
          <select className="vc-select" aria-label="Process" value="independent-review" onChange={() => undefined}>
            <option value="independent-review">Independent review</option>
          </select>
        </Field>
        <Field label="Most one run may spend ($)" hint="A run stops at this cost.">
          <Input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
      </div>
      {error && (
        <p className="vc-error" role="alert">
          {error}
        </p>
      )}
      <div className="vc-form-actions start">
        <Button type="submit" variant="secondary">
          Save panel
        </Button>
      </div>
    </form>
  );
}

/** Settings → Roles: VibeCab's agent with what it may do, then the TMR panel. */
export function Roles({
  settings,
  sessions,
  replies,
}: {
  settings: SettingsShape | undefined;
  sessions: SessionRow[];
  /** How it replies: kept in Settings beside the budgets it saves into. */
  replies: ReactNode;
}) {
  return (
    <>
      <AgentGroup
        id="vibecab-role"
        name="VibeCab"
        about={`The agent that works in your ${terms.session.toLowerCase()}s. It replies to comments and writes ${terms.update}s.`}
      >
        <Section id="vibecab-agent" level={3} title="Who works for VibeCab">
          {settings ? <VibecabAgent settings={settings} /> : null}
        </Section>
        {replies}
        <GrantsSection sessions={sessions} />
        <ToolsSection />
      </AgentGroup>
      <AgentGroup
        id="tmr-role"
        name="TMR"
        about="The Majority Report. A panel of agents reviews a question. Each agent answers alone, then one agent writes the summary."
      >
        <Section id="tmr-panel" level={3} title="The panel">
          {settings ? <TmrPanel key={JSON.stringify(settings.roles?.tmr ?? {})} settings={settings} /> : null}
        </Section>
      </AgentGroup>
    </>
  );
}
