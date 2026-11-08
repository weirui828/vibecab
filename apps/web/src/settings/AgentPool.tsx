import { useState } from "react";
import { Button, Field, Input, Textarea } from "@wei/design-system";
import type { ProviderModel } from "../../../../contract/generated/index.js";
import { providerCatalog } from "../../../../contract/src/provider-catalog.js";
import { useBridge, useLiveQuery } from "../live/LiveStore.js";
import { agentNames, dollars, useRun } from "./common.js";
import { ModelForm } from "./ModelForm.js";
import type { SettingsShape } from "./ModelForm.js";

// W13: the agent pool. Each agent is a model entry with a name and optional instructions; its alias is its id.
// Roles (Settings → Roles) say which agent works for VibeCab and which sit on the TMR panel.

type Sdk = "claude-agent-sdk" | "codex-sdk";
type RunsOn = "provider" | Sdk;
const sdk: Record<Sdk, { name: string; pays: string; setup: string; modelHint: string }> = {
  "claude-agent-sdk": {
    name: "Claude Code",
    pays: "your Claude subscription pays",
    setup: "Install Claude Code on this computer. To sign in, run claude in a terminal.",
    modelHint: "If you do not type a model, Claude Code uses its default model, for example claude-sonnet-5-5.",
  },
  "codex-sdk": {
    name: "Codex",
    pays: "your ChatGPT subscription pays",
    setup: "Install Codex on this computer. To sign in, run codex login in a terminal.",
    modelHint: "If you do not type a model, Codex uses its default model, for example gpt-6.1-sol.",
  },
};
const isSdk = (provider: string): provider is Sdk => provider in sdk;
type Stats = { groups: Array<{ key: string; calls: number; inputTokens: number; outputTokens: number }> };

/** An SDK agent's model config, as the engine stores it: no key (its own sign-in), priced at zero. */
export function sdkConfig(kind: Sdk, model: string) {
  return {
    provider: kind,
    baseUrl: kind === "claude-agent-sdk" ? "sdk://claude-code" : "sdk://codex",
    model: model.trim() || "default",
    capabilities: {
      tools: true,
      jsonSchemaOutput: true,
      streaming: true,
      maxContextTokens: 200_000,
      reportsUsage: true,
    },
    pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
  };
}

/** A new agent's id: from its name, never one in use, and never an id that means something else. */
export function aliasFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent";
  const reserved = new Set([...taken, "vibecab", "reply"]);
  if (!reserved.has(base)) return base;
  for (let n = 2; ; n++) if (!reserved.has(`${base}-${n}`)) return `${base}-${n}`;
}

export const nameOf = (id: string, model: ProviderModel | undefined) => model?.name?.trim() || agentNames[id] || id;

/** What an agent runs on, and who pays, in one line. */
export function runsOn(model: ProviderModel): string {
  if (isSdk(model.provider))
    return `${sdk[model.provider].name}${model.model !== "default" ? ` (${model.model})` : ""} · ${sdk[model.provider].pays}`;
  const provider = providerCatalog.providers.find((p) => p.id === model.catalogProvider)?.name ?? model.baseUrl;
  const { inputMicrosPerMillion: i, outputMicrosPerMillion: o } = model.pricing;
  return `${model.model} on ${provider} · ${i || o ? `$${dollars(i)} in, $${dollars(o)} out per million tokens` : "price not known"}`;
}

/** Name, what it runs on, and instructions: one form for a new agent or an agent in the pool. */
function AgentEditor({
  id,
  settings,
  onDone,
}: {
  id: string | undefined;
  settings: SettingsShape | undefined;
  onDone(): void;
}) {
  const run = useRun(),
    bridge = useBridge(),
    models = settings?.models ?? {},
    current = id ? models[id] : undefined,
    [name, setName] = useState(current?.name ?? (id ? nameOf(id, current) : "")),
    [kind, setKind] = useState<RunsOn>(current && isSdk(current.provider) ? current.provider : "provider"),
    [sdkModel, setSdkModel] = useState(current && current.model !== "default" ? current.model : ""),
    [instructions, setInstructions] = useState(current?.instructions ?? ""),
    [error, setError] = useState<string>(),
    alias = id ?? aliasFor(name, Object.keys(models));
  const check = () => (name.trim() ? undefined : "Type a name for the agent.");
  // The first agent works for VibeCab at once, so a new workspace needs no trip to Roles. Asked fresh: the page's
  // copy of the settings may be a refresh behind the save that just happened.
  const saved = async (savedAlias: string) => {
    const now = await bridge.query<SettingsShape>("sys.Settings", {});
    if (!now.roles?.vibecab && Object.keys(now.models ?? {}).every((m) => m === savedAlias))
      await run("sys.SetSettings", { patch: { roles: { vibecab: savedAlias } } });
    onDone();
  };
  const lead = (
    <>
      <Field label="Name" hint="The name you see in sessions, in TMR reports and in usage.">
        <Input inputSize="lg" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Runs on">
        <select
          className="vc-select"
          aria-label="Runs on"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as RunsOn);
            setError(undefined);
          }}
        >
          <option value="provider">A model provider (you pay per use, with an API key)</option>
          <option value="claude-agent-sdk">Claude Code (your Claude subscription)</option>
          <option value="codex-sdk">Codex (your ChatGPT subscription)</option>
        </select>
      </Field>
    </>
  );
  const tail = (
    <Field
      label="Instructions (optional)"
      hint="VibeCab sends these with each request this agent gets. For example: “Be a skeptic. Look for what is missing.”"
    >
      <Textarea rows={3} maxLength={4000} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
    </Field>
  );
  // The first agent has nothing to go back to.
  const actions = Object.keys(models).length > 0 && (
    <Button type="button" variant="ghost" onClick={onDone}>
      Cancel
    </Button>
  );
  return (
    <section className="vc-agent-editor" aria-label={id ? `Edit ${nameOf(id, current)}` : "New agent"}>
      {kind === "provider" ? (
        <>
          <ModelForm
            key={kind}
            alias={alias}
            submitLabel={id ? "Save" : "Add agent"}
            extra={{ name, instructions }}
            lead={lead}
            tail={tail}
            check={check}
            onSaved={(a) => void saved(a)}
          />
          <div className="vc-form-actions start">{actions}</div>
        </>
      ) : (
        <form
          className="vc-form"
          onSubmit={(e) => {
            e.preventDefault();
            const problem = check();
            if (problem) return setError(problem);
            void run("sys.SetSettings", {
              patch: {
                models: {
                  [alias]: {
                    ...sdkConfig(kind, sdkModel),
                    name: name.trim(),
                    ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
                  },
                },
              },
            }).then((ok) => {
              if (ok !== undefined) void saved(alias);
            });
          }}
        >
          {lead}
          <p className="vc-muted small">{sdk[kind].setup}</p>
          <Field label={`${sdk[kind].name} model`} hint={sdk[kind].modelHint}>
            <Input value={sdkModel} placeholder="default" onChange={(e) => setSdkModel(e.target.value)} />
          </Field>
          {tail}
          {error && (
            <p className="vc-error" role="alert">
              {error}
            </p>
          )}
          <div className="vc-form-actions">
            {actions}
            <Button type="submit" variant="primary">
              {id ? "Save" : "Add agent"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function AgentCard({
  id,
  model,
  settings,
  usage,
  editing,
  onEdit,
  onDone,
}: {
  id: string;
  model: ProviderModel;
  settings: SettingsShape | undefined;
  usage: Stats["groups"][number] | undefined;
  editing: boolean;
  onEdit(): void;
  onDone(): void;
}) {
  const run = useRun(),
    [confirm, setConfirm] = useState(false),
    name = nameOf(id, model),
    roles = [
      settings?.roles?.vibecab === id && "Works for VibeCab",
      settings?.roles?.tmr?.panel.some((m) => m.agentId === id) && "On the TMR panel",
    ].filter(Boolean);
  return (
    <section className="vc-pool-agent" aria-labelledby={`agent-${id}-name`}>
      <header>
        <h3 id={`agent-${id}-name`}>{name}</h3>
        <p className="vc-facts">{runsOn(model)}</p>
        <p className="vc-facts">
          {[
            ...roles,
            usage ? `${usage.calls} calls in 30 days` : "Not used in 30 days",
            !model.capabilities.tools && "Cannot use tools, so it cannot work in sessions",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {model.instructions && !editing && <p className="vc-instructions">{model.instructions}</p>}
      </header>
      {editing ? (
        <AgentEditor id={id} settings={settings} onDone={onDone} />
      ) : (
        <div className="vc-form-actions start">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            Edit
          </Button>
          {confirm ? (
            <>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void run("sys.SetSettings", { patch: { models: { [id]: null } } })}
              >
                Remove {name}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** Settings → Agents: every agent in the pool, and a way to add one. */
export function AgentPool({ settings }: { settings: SettingsShape | undefined }) {
  const models = settings?.models ?? {},
    ids = Object.keys(models).sort((a, b) => nameOf(a, models[a]).localeCompare(nameOf(b, models[b]))),
    [editing, setEditing] = useState<string>(),
    now = new Date(),
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).toISOString(),
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
    stats = useLiveQuery<Stats>("sys.UsageStats", { from, to, groupBy: "agent" });
  const adding = editing === "" || (settings !== undefined && ids.length === 0);
  return (
    <section className="vc-agent" id="pool" aria-labelledby="pool-name">
      <header>
        <h2 id="pool-name">Your agents</h2>
        <p className="lede">
          Each agent has a name and runs on a model, Claude Code or Codex. In Roles, choose the agent that works in your
          sessions and the agents on the TMR panel.
        </p>
      </header>
      <div className="vc-pool">
        {ids.map((id) => (
          <AgentCard
            key={id}
            id={id}
            model={models[id]!}
            settings={settings}
            usage={stats.data?.groups.find((g) => g.key === id)}
            editing={editing === id}
            onEdit={() => setEditing(id)}
            onDone={() => setEditing(undefined)}
          />
        ))}
      </div>
      {adding ? (
        <AgentEditor id={undefined} settings={settings} onDone={() => setEditing(undefined)} />
      ) : (
        settings && (
          <Button variant="secondary" onClick={() => setEditing("")}>
            Add an agent
          </Button>
        )
      )}
    </section>
  );
}
