import { useState } from "react";
import { Button, Field, Input } from "@wei/design-system";
import { terms } from "../../../ui/src/copy/terms.js";
import { useLiveQuery } from "../live/LiveStore.js";
import { AgentGroup, Section, useRun } from "./common.js";
import type { SettingsShape } from "./ModelForm.js";

type Kind = "claude-agent-sdk" | "codex-sdk";
const agents: Record<
  "claude-code" | "codex",
  { kind: Kind; name: string; about: string; setup: string; modelHint: string }
> = {
  "claude-code": {
    kind: "claude-agent-sdk",
    name: "Claude Code",
    about:
      "Claude Code runs on this computer with your Claude sign-in. Your subscription pays for it. It replies in threads. VibeCab does each action itself, as the agent.",
    setup: "Install Claude Code. To sign in, run claude in a terminal.",
    modelHint: "If you do not type a model, Claude Code uses its default model, for example claude-sonnet-5-5.",
  },
  codex: {
    kind: "codex-sdk",
    name: "Codex",
    about:
      "Codex runs on this computer with your ChatGPT or OpenAI sign-in. It cannot change files or use the network. It replies in threads. VibeCab does each action itself, as the agent.",
    setup: "Install Codex. To sign in, run codex login in a terminal.",
    modelHint: "If you do not type a model, Codex uses its default model, for example gpt-6.1-sol.",
  },
};
type Stats = {
  groups: Array<{ key: string; calls: number; inputTokens: number; outputTokens: number; errors: number }>;
};

/** Its model config, as the engine stores it: no key (its own sign-in), priced at zero. */
function config(kind: Kind, model: string) {
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

function SdkAgent({
  id,
  settings,
  stats,
}: {
  id: "claude-code" | "codex";
  settings: SettingsShape | undefined;
  stats: Stats | undefined;
}) {
  const agent = agents[id],
    run = useRun(),
    current = settings?.models?.[id],
    [model, setModel] = useState<string>();
  const shown = model ?? (current && current.model !== "default" ? current.model : "");
  const usage = stats?.groups.find((g) => g.key === id);
  const save = async (on: boolean) => {
    if (await run("sys.SetSettings", { patch: { models: { [id]: on ? config(agent.kind, shown) : null } } }))
      setModel(undefined);
  };
  return (
    <AgentGroup
      id={id + "-agent"}
      name={agent.name}
      about={agent.about}
      facts={
        current
          ? usage
            ? `On. ${usage.calls} calls in 30 days, ${Math.round((usage.inputTokens + usage.outputTokens) / 1000)}K tokens` +
              (usage.errors ? `, ${usage.errors} failed.` : ".")
            : `On. Not used. Choose it in the Agent panel of a ${terms.session.toLowerCase()}.`
          : "Off"
      }
    >
      <Section id={id + "-setup"} level={3} title={current ? "Its model" : "Turn it on"} lede={agent.setup}>
        <form
          className="vc-inline-setting"
          onSubmit={(e) => {
            e.preventDefault();
            void save(true);
          }}
        >
          <Field label={`${agent.name} model`} hint={agent.modelHint}>
            <Input value={shown} placeholder="default" onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Button
            type="submit"
            variant={current ? "ghost" : "secondary"}
            disabled={Boolean(current) && model === undefined}
          >
            {current ? "Save" : `Use ${agent.name}`}
          </Button>
        </form>
        {current && (
          <Button variant="ghost" size="sm" onClick={() => void save(false)}>
            Turn {agent.name} off
          </Button>
        )}
      </Section>
    </AgentGroup>
  );
}

/** The SDK agents (W12): Claude Code and Codex, each with its own sign-in. */
export function SdkAgents({ settings }: { settings: SettingsShape | undefined }) {
  const now = new Date(),
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).toISOString(),
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const stats = useLiveQuery<Stats>("sys.UsageStats", { from, to, groupBy: "agent" });
  return (
    <>
      <SdkAgent id="claude-code" settings={settings} stats={stats.data} />
      <SdkAgent id="codex" settings={settings} stats={stats.data} />
    </>
  );
}
