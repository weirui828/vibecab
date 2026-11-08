import { useEffect, useRef, useState } from "react";
import { Button, Field, Input } from "@wei/design-system";
import { terms } from "../../../ui/src/copy/terms.js";
import { useBridge, useLiveQuery } from "../live/LiveStore.js";
import type { SessionRow } from "../live/workspace.js";
import { ThemeSwitch } from "../shell/Navigation.js";
import { navigate } from "../shell/prefs.js";
import type { ThemeChoice } from "../shell/prefs.js";
import { relativeTime } from "../ui/time.js";
import { AssistantSection, DataSection } from "./AccessSections.js";
import { AgentGroup, Section, dollars, toMicros, useAgentName, useRun } from "./common.js";
import { UsageSection } from "./UsageSection.js";
import { EngineFacts } from "./EngineFacts.js";
import type { AppState } from "../bridge/webBridge.js";
import { AgentPool } from "./AgentPool.js";
import { Roles } from "./Roles.js";
import type { SettingsShape } from "./ModelForm.js";

interface BudgetState {
  account: { kind: string; key?: string };
  limitMicros: number | null;
  usedMicros: number;
  reservedMicros: number;
}
interface CallLog {
  callId: string;
  alias: string;
  model: string;
  settledMicros?: number;
  reservedMicros: number;
  usageQuality: "reported" | "estimated" | "unknown";
  finishReason?: string;
  errorCode?: string;
  createdAt: string;
}

type Spend = { limitMicros: number | null; usedMicros: number; reservedMicros: number };
type Today = { date: string; daily: Spend; agents: Array<Spend & { agentId: string }> };
/** An agent paid by its own subscription (W12) is never charged here. */
const subscriptionKinds = new Set(["claude-agent-sdk", "codex-sdk"]);

/** One agent's line: today's use, and its own daily limit beside the overall one. */
function AgentLimit({ agent, provider }: { agent: Spend & { agentId: string }; provider: string | undefined }) {
  const run = useRun(),
    [limit, setLimit] = useState<string>(),
    name = useAgentName()(agent.agentId);
  if (provider && subscriptionKinds.has(provider))
    return (
      <li>
        <span className="what">
          {name}
          <span className="vc-facts">Its subscription pays. VibeCab does not count its cost.</span>
        </span>
      </li>
    );
  return (
    <li>
      <span className="what">
        {name}
        <span className="vc-facts">
          ${dollars(agent.usedMicros)} today
          {agent.limitMicros != null ? ` of $${dollars(agent.limitMicros)}` : " · only the overall limit"}
        </span>
      </span>
      <form
        className="vc-inline-setting"
        onSubmit={(e) => {
          e.preventDefault();
          const value = limit?.trim() ? toMicros(limit) : null;
          if (value === undefined) return;
          void run("sys.SetBudget", { account: { kind: "agent", key: agent.agentId }, limitMicros: value }).then(
            (ok) => ok !== undefined && setLimit(undefined),
          );
        }}
      >
        <Field label={`${name}: daily limit ($)`} hideLabel>
          <Input
            inputMode="decimal"
            placeholder="No own limit"
            value={limit ?? (agent.limitMicros != null ? dollars(agent.limitMicros) : "")}
            onChange={(e) => setLimit(e.target.value)}
          />
        </Field>
        <Button type="submit" size="sm" variant="ghost" disabled={limit === undefined}>
          Save
        </Button>
      </form>
    </li>
  );
}

function SpendingSection({ budgets, models }: { budgets: SettingsShape["budgets"]; models: SettingsShape["models"] }) {
  const usage = useLiveQuery<{ accounts: BudgetState[]; calls: CallLog[] }>("sys.Usage", {}),
    today = useLiveQuery<Today>("sys.SpendingToday", {}),
    run = useRun(),
    [limit, setLimit] = useState<string>(),
    [turn, setTurn] = useState<string>();
  async function saveTurn() {
    const value = turn?.trim() ? toMicros(turn) : undefined;
    if (value === undefined) return;
    if (await run("sys.SetSettings", { patch: { budgets: { ...budgets, defaultTurnLimitMicros: value } } }))
      setTurn(undefined);
  }
  // Today's account, not just any daily one: each day has its own.
  const daily = today.data?.daily,
    agents = today.data?.agents ?? [];
  const calls = [...(usage.data?.calls ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  async function save() {
    const value = limit?.trim() ? toMicros(limit) : null;
    if (value === undefined) return;
    if (await run("sys.SetBudget", { account: { kind: "daily" }, limitMicros: value })) setLimit(undefined);
  }
  return (
    <Section
      id="spending"
      title="Spending"
      lede="Before each model call, VibeCab reserves the maximum cost of that call. VibeCab stops calls at your daily limit."
    >
      <p className="vc-stat">
        <span className="big">${dollars(daily?.usedMicros ?? 0)}</span>
        <span className="vc-facts">
          spent today{daily?.limitMicros != null ? ` of $${dollars(daily.limitMicros)}` : " · no limit"}
          {daily?.reservedMicros ? ` · $${dollars(daily.reservedMicros)} reserved` : ""}
        </span>
      </p>
      <form
        className="vc-inline-setting"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Daily limit in dollars" hint="Leave empty for no limit.">
          <Input
            inputMode="decimal"
            value={limit ?? (daily?.limitMicros != null ? dollars(daily.limitMicros) : "")}
            onChange={(e) => setLimit(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="ghost" disabled={limit === undefined}>
          Save
        </Button>
      </form>
      <form
        className="vc-inline-setting"
        onSubmit={(e) => {
          e.preventDefault();
          void saveTurn();
        }}
      >
        <Field label="Maximum cost of one reply ($)" hint="An agent reply stops at this cost.">
          <Input
            inputMode="decimal"
            value={turn ?? (budgets?.defaultTurnLimitMicros != null ? dollars(budgets.defaultTurnLimitMicros) : "")}
            onChange={(e) => setTurn(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="ghost" disabled={turn === undefined}>
          Save
        </Button>
      </form>
      {agents.length > 0 && (
        <div className="vc-agent-limits">
          <p className="vc-label">Per agent</p>
          <ul className="vc-plain-list">
            {agents.map((agent) => (
              <AgentLimit key={agent.agentId} agent={agent} provider={models?.[agent.agentId]?.provider} />
            ))}
          </ul>
        </div>
      )}
      {calls.length > 0 && (
        <table className="vc-calls">
          <caption className="vc-label">Recent model calls</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">For</th>
              <th scope="col">Model</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.callId} data-uncertain={c.usageQuality !== "reported" || undefined}>
                <td>{relativeTime(c.createdAt)}</td>
                <td>{c.alias}</td>
                <td>{c.model}</td>
                <td>
                  ${dollars(c.settledMicros ?? c.reservedMicros)}
                  {c.usageQuality !== "reported" && <span className="vc-muted"> (estimated)</span>}
                  {c.errorCode && <span className="vc-muted"> · {c.errorCode}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function RepliesSection({ budgets }: { budgets: SettingsShape["budgets"] }) {
  const run = useRun(),
    [delay, setDelay] = useState<string>(),
    [tools, setTools] = useState<string>();
  async function save() {
    const patch: Record<string, number> = {};
    if (delay !== undefined && Number.isInteger(Number(delay)) && Number(delay) >= 1)
      patch.realtimeDebounceSeconds = Number(delay);
    if (tools !== undefined && Number.isInteger(Number(tools)) && Number(tools) >= 1)
      patch.toolCallLimit = Number(tools);
    if (!Object.keys(patch).length) return;
    if (await run("sys.SetSettings", { patch: { budgets: { ...budgets, ...patch } } })) {
      setDelay(undefined);
      setTools(undefined);
    }
  }
  return (
    <Section
      id="replies"
      level={3}
      title="How it replies"
      lede={`How quickly it replies in Realtime ${terms.session.toLowerCase()}s. You set the reply mode in each ${terms.session.toLowerCase()}. Set the maximum cost of a reply in Spending.`}
    >
      <form
        className="vc-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="vc-form-row">
          <Field label="Delay before a reply (seconds)">
            <Input
              inputMode="numeric"
              value={delay ?? String(budgets?.realtimeDebounceSeconds ?? 10)}
              onChange={(e) => setDelay(e.target.value)}
            />
          </Field>
          <Field label="Tool uses per reply">
            <Input
              inputMode="numeric"
              value={tools ?? String(budgets?.toolCallLimit ?? 8)}
              onChange={(e) => setTools(e.target.value)}
            />
          </Field>
        </div>
        <div className="vc-form-actions start">
          <Button type="submit" variant="secondary" disabled={delay === undefined && tools === undefined}>
            Save
          </Button>
        </div>
      </form>
    </Section>
  );
}

function AnotherBrowser() {
  const bridge = useBridge(),
    [link, setLink] = useState<string>(),
    [copied, setCopied] = useState(false);
  return (
    <Section
      id="browser"
      title="Open on another browser"
      lede="Each browser signs in with its own link. You can use the link one time."
    >
      {link ? (
        <div className="vc-secret">
          <pre>{link}</pre>
          <div className="vc-form-actions start">
            <Button
              variant="secondary"
              onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}
            >
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="secondary"
          onClick={() =>
            void bridge.app.launchLink().then((url) => {
              setLink(url);
              setCopied(false);
            })
          }
        >
          Make a sign-in link
        </Button>
      )}
      <p className="vc-muted small">
        From a terminal: <code>node apps/web/bin/vibecab-web.mjs link</code>
      </p>
    </Section>
  );
}

const tabs = [
  ["agents", "Agents"],
  ["roles", "Roles"],
  ["spending", "Spending"],
  ["general", "General"],
] as const;
type Tab = (typeof tabs)[number][0];

/** Older addresses: the tab each part now lives in, and the part to scroll to. */
const moved: Record<string, [Tab, string]> = {
  model: ["agents", "pool"],
  agent: ["roles", "replies"],
  permissions: ["roles", "permissions"],
  tools: ["roles", "tools"],
  assistant: ["agents", "assistants-agent"],
  data: ["general", "data"],
  appearance: ["general", "appearance"],
  about: ["general", "about"],
};

/** Settings as tabs, one section at a time; the tab is in the address (`#/settings/agent`), so it survives a reload. */
export function SettingsView({
  tab: asked,
  sessions,
  theme,
  setTheme,
}: {
  tab: string;
  sessions: SessionRow[];
  theme: ThemeChoice;
  setTheme(choice: ThemeChoice): void;
}) {
  const bridge = useBridge(),
    settings = useLiveQuery<SettingsShape>("sys.Settings", {}),
    caps = useLiveQuery<{ contractVersion: string }>("sys.Capabilities", {}),
    [state, setState] = useState<AppState>(),
    list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void bridge.app.state().then(setState, () => undefined);
  }, [bridge]);
  const old = moved[asked],
    tab: Tab = old?.[0] ?? tabs.find(([id]) => id === asked)?.[0] ?? "agents";
  // An old address opens the tab where that part now lives, scrolled to it.
  useEffect(() => {
    if (!old) return;
    navigate("/settings/" + old[0]);
    setTimeout(() => document.getElementById(old[1])?.scrollIntoView?.({ block: "start" }), 50);
  }, [old]);
  const go = (id: Tab, focus = false) => {
    navigate("/settings/" + id);
    if (focus) setTimeout(() => list.current?.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.focus(), 0);
  };
  // ← → move between tabs, Home and End jump to the ends (the usual tablist keys).
  const onKey = (event: React.KeyboardEvent) => {
    const at = tabs.findIndex(([id]) => id === tab),
      to =
        event.key === "ArrowRight"
          ? (at + 1) % tabs.length
          : event.key === "ArrowLeft"
            ? (at - 1 + tabs.length) % tabs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : -1;
    const next = tabs[to];
    if (!next) return;
    event.preventDefault();
    go(next[0], true);
  };
  return (
    <div className="vc-page vc-settings">
      <header className="vc-header">
        <h1 className="vc-display">Settings</h1>
      </header>
      <div className="vc-tabs" role="tablist" aria-label="Settings" ref={list} onKeyDown={onKey}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={"tab-" + id}
            data-tab={id}
            aria-selected={id === tab}
            aria-controls={"panel-" + id}
            tabIndex={id === tab ? 0 : -1}
            onClick={() => go(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="vc-tab-panel" role="tabpanel" id={"panel-" + tab} aria-labelledby={"tab-" + tab} key={tab}>
        {tab === "agents" && (
          <>
            <AgentPool settings={settings.data} />
            <AgentGroup
              id="assistants-agent"
              name="Your AI assistants"
              about="Claude Desktop, Codex, Cursor and other MCP clients can work here as you, through the MCP server of VibeCab. They can read, comment and agree. They cannot change settings, keys or permissions."
            >
              <AssistantSection workspace={state?.workspacePath ?? ""} relayPath={state?.mcpRelayPath} />
            </AgentGroup>
          </>
        )}
        {tab === "roles" && (
          <Roles
            settings={settings.data}
            sessions={sessions}
            replies={<RepliesSection budgets={settings.data?.budgets} />}
          />
        )}
        {tab === "spending" && (
          <>
            <SpendingSection budgets={settings.data?.budgets} models={settings.data?.models} />
            <UsageSection sessions={sessions} />
          </>
        )}
        {tab === "general" && (
          <>
            <DataSection workspace={state?.workspacePath ?? ""} retention={settings.data?.trashRetentionDays} />
            <Section id="appearance" title="Appearance" lede="Auto uses the light or dark setting of this computer.">
              <ThemeSwitch theme={theme} setTheme={setTheme} />
            </Section>
            <AnotherBrowser />
            <Section id="about" title="About">
              <p className="vc-facts">
                VibeCab {state?.version ?? ""} · contract {caps.data?.contractVersion ?? "…"}
              </p>
              <EngineFacts
                engine={state?.engine}
                onRestart={async () => {
                  await bridge.app.restartEngine();
                  setState(await bridge.app.state());
                }}
              />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
