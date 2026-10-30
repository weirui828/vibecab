import { useEffect, useState } from "react";
import type { Settings } from "../../../../contract/generated/index.js";
import { AliasModel, ModelAdvanced, Spending } from "./SettingsFields.js";
import { AgentDefaults } from "./AgentDefaults.js";
import { SettingsAppearance } from "./SettingsAppearance.js";
type Tab =
  | "Model"
  | "Spending"
  | "Agent"
  | "Grants"
  | "Connected tools"
  | "AI assistant (MCP)"
  | "Data"
  | "Appearance"
  | "About";
type SessionDefaults = Settings["sessions"][string];
const tabs: Tab[] = [
  "Model",
  "Spending",
  "Agent",
  "Grants",
  "Connected tools",
  "AI assistant (MCP)",
  "Data",
  "Appearance",
  "About",
];

export function SettingsView({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("Model"),
    [settings, setSettings] = useState<Settings>(),
    [message, setMessage] = useState(""),
    [modelName, setModelName] = useState(""),
    [baseUrl, setBaseUrl] = useState(""),
    [apiKey, setApiKey] = useState(""),
    [agentDefaults, setAgentDefaults] = useState<SessionDefaults>({}),
    [token, setToken] = useState(""),
    [showTokenChoices, setShowTokenChoices] = useState(false),
    [tokens, setTokens] = useState<
      Array<{ tokenId: string; name: string; channel: string; scope: string; revokedAt?: string }>
    >([]),
    [backups, setBackups] = useState<unknown[]>([]),
    [grants, setGrants] = useState<Array<{ grantId: string; capabilities: string[] }>>([]),
    [servers, setServers] = useState<unknown[]>([]),
    [toolName, setToolName] = useState(""),
    [toolUrl, setToolUrl] = useState(""),
    [toolSecret, setToolSecret] = useState(""),
    [toolCalls, setToolCalls] = useState<unknown[]>([]),
    [exports, setExports] = useState<unknown[]>([]),
    [version, setVersion] = useState(""),
    [nodeVersion, setNodeVersion] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [relayPath, setRelayPath] = useState(""),
    [retentionDays, setRetentionDays] = useState(30);
  const load = async () => {
    const value = await window.vibecab.query<Settings>("sys.Settings", {});
    setSettings(value);
    const model = value.models.default;
    setModelName(model?.model ?? "");
    setBaseUrl(model?.baseUrl ?? "");
    setAgentDefaults(value.sessions.default ?? {});
    setRetentionDays(value.trashRetentionDays ?? 30);
  };
  useEffect(() => {
    void window.vibecab.app.workspacePath().then(setWorkspace);
    void window.vibecab.app.mcpRelayPath().then(setRelayPath);
    void load();
  }, []);
  useEffect(() => {
    if (tab === "AI assistant (MCP)")
      void window.vibecab.query<typeof tokens>("sys.AccessTokens", {}).then((value) => setTokens(value));
    if (tab === "Grants") void window.vibecab.query<typeof grants>("vc.Grants", {}).then(setGrants);
    if (tab === "Connected tools") {
      void window.vibecab.query<unknown[]>("vc.ToolServers", {}).then(setServers);
      void window.vibecab.query<unknown[]>("vc.ToolCalls", {}).then(setToolCalls);
    }
    if (tab === "Data") {
      void window.vibecab.query<unknown[]>("sys.Backups", {}).then(setBackups);
      void window.vibecab.query<unknown[]>("vc.Exports", {}).then(setExports);
      void window.vibecab.app.workspacePath().then(setWorkspace);
      return window.vibecab.subscribe(0, {}, (event) => {
        if (event.type !== "vc.LifecycleChanged" || typeof event.payload !== "object" || event.payload === null) return;
        if (Reflect.get(event.payload, "kind") === "backup" && Reflect.get(event.payload, "action") === "completed") {
          setMessage("Backup completed. Reveal it from the list below.");
          void window.vibecab.query<unknown[]>("sys.Backups", {}).then(setBackups);
        }
        const payload = event.payload;
        if (Reflect.get(payload, "kind") === "export" && Reflect.get(payload, "action") === "completed")
          void window.vibecab
            .query<Array<{ exportId: string; status: string; blobHash?: string; format: string }>>("vc.Exports", {})
            .then(async (items) => {
              setExports(items);
              const exportId = Reflect.get(payload, "id"),
                item = items.find((candidate) => candidate.exportId === exportId);
              if (!item?.blobHash) return;
              const bytes = await window.vibecab.getBlob(item.blobHash),
                ext = item.format === "markdown" ? "md" : item.format;
              await window.vibecab.app.saveFiles([{ name: `VibeCab-export.${ext}`, bytes }]);
            })
            .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not save export."));
      });
    }
    if (tab === "About") {
      void window.vibecab.app.version().then(setVersion);
      void window.vibecab.app.nodeVersion().then(setNodeVersion);
    }
  }, [tab]);
  const saveSettings = async (patch: Record<string, unknown>) => {
    const result = await window.vibecab.command("sys.SetSettings", { patch });
    if (!result.ok) setMessage(result.error.message);
    else {
      const saved = result.result;
      if (typeof saved === "object" && saved !== null) {
        const updated = Reflect.get(saved, "settings");
        if (typeof updated === "object" && updated !== null) setSettings(updated as unknown as Settings);
      }
      setMessage("Settings saved");
    }
  };
  const createToken = async (scope: "read" | "collaborate") => {
    const result = await window.vibecab.command("sys.CreateAccessToken", {
      name: scope === "read" ? "MCP read access" : "MCP collaborate access",
      channel: "mcp",
      scope,
    });
    if (!result.ok) return setMessage(result.error.message);
    const created = result.result as { token: string };
    setToken(created.token);
    void window.vibecab.query<typeof tokens>("sys.AccessTokens", {}).then(setTokens);
  };
  return (
    <section className="settings-view">
      <div className="row">
        <h2>Settings</h2>
        <button onClick={onBack}>Back</button>
      </div>
      <nav aria-label="Settings tabs">
        {tabs.map((item) => (
          <button key={item} aria-current={tab === item} onClick={() => setTab(item)}>
            {item}
          </button>
        ))}
      </nav>
      {tab === "Model" ? (
        <section aria-label="Model settings">
          <label>
            Provider base URL
            <input
              aria-label="Provider base URL"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            Model name
            <input aria-label="Model name" value={modelName} onChange={(event) => setModelName(event.target.value)} />
          </label>
          <label>
            API key (replace only)
            <input
              aria-label="API key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <button
            disabled={!settings?.models.default}
            onClick={async () => {
              const latest = await window.vibecab.query<Settings>("sys.Settings", {});
              setSettings(latest);
              const current = latest.models.default;
              if (!current) return setMessage("Settings are still loading.");
              await saveSettings({ models: { default: { ...current, baseUrl, model: modelName } } });
              if (apiKey) {
                await window.vibecab.app.saveProvider(baseUrl, modelName, apiKey);
                setApiKey("");
              }
            }}
          >
            Save model
          </button>
          {settings?.models.default ? (
            <ModelAdvanced
              model={settings.models.default}
              onSave={(model) => void saveSettings({ models: { default: model } })}
            />
          ) : null}
          <details>
            <summary>Advanced model aliases</summary>
            {(["reply", "writer", "judge", "digest"] as const).map((alias) => (
              <AliasModel
                key={alias}
                alias={alias}
                model={settings?.models[alias]}
                fallback={settings?.models.default}
                onSave={(model) => void saveSettings({ models: { [alias]: model } })}
              />
            ))}
          </details>
        </section>
      ) : null}
      {tab === "Spending" ? (
        <Spending
          settings={settings}
          onSave={(limitMicros) =>
            void window.vibecab
              .command("sys.SetBudget", { account: { kind: "daily" }, limitMicros })
              .then((result) => setMessage(result.ok ? "Spending limit saved" : result.error.message))
          }
        />
      ) : null}
      {tab === "Agent" ? (
        <AgentDefaults
          value={agentDefaults}
          original={settings?.sessions.default ?? {}}
          onChange={setAgentDefaults}
          onSave={(patch) => void saveSettings({ sessions: { default: patch } })}
        />
      ) : null}
      {tab === "Grants" ? (
        <section aria-label="Grants">
          {grants.map((grant) => (
            <p key={grant.grantId}>
              {grant.capabilities.join(", ")}{" "}
              <button
                onClick={() =>
                  void window.vibecab
                    .command("vc.RevokeGrant", { grantId: grant.grantId })
                    .then(() => window.vibecab.query<typeof grants>("vc.Grants", {}).then(setGrants))
                }
              >
                Revoke
              </button>
            </p>
          ))}
        </section>
      ) : null}
      {tab === "Connected tools" ? (
        <section aria-label="Connected tools">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                let credentialRef: string | undefined;
                if (toolSecret) {
                  const stored = await window.vibecab.command("sys.SetProviderKey", {
                    alias: `tool-${toolName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
                    secret: toolSecret,
                  });
                  if (!stored.ok) return setMessage(stored.error.message);
                  const result = stored.result;
                  if (
                    typeof result === "object" &&
                    result !== null &&
                    typeof Reflect.get(result, "keyRef") === "string"
                  )
                    credentialRef = Reflect.get(result, "keyRef");
                }
                const connected = await window.vibecab.command("vc.ConnectToolServer", {
                  name: toolName,
                  transport: { kind: "http", url: toolUrl },
                  scope: {},
                  ...(credentialRef ? { credentialRef } : {}),
                });
                setMessage(connected.ok ? "Tool server connected" : connected.error.message);
                if (connected.ok) {
                  setToolSecret("");
                  setServers(await window.vibecab.query<unknown[]>("vc.ToolServers", {}));
                }
              })();
            }}
          >
            <label>
              Server name
              <input
                aria-label="Tool server name"
                value={toolName}
                onChange={(event) => setToolName(event.target.value)}
              />
            </label>
            <label>
              HTTP server URL
              <input
                aria-label="Tool server URL"
                value={toolUrl}
                onChange={(event) => setToolUrl(event.target.value)}
              />
            </label>
            <label>
              Bearer credential
              <input
                aria-label="Tool server credential"
                type="password"
                value={toolSecret}
                onChange={(event) => setToolSecret(event.target.value)}
              />
            </label>
            <button type="submit">Connect tool server</button>
          </form>
          {servers.map((raw) => {
            if (typeof raw !== "object" || raw === null) return null;
            const serverId = Reflect.get(raw, "serverId"),
              name = Reflect.get(raw, "name"),
              tools = Reflect.get(raw, "tools");
            if (typeof serverId !== "string" || !Array.isArray(tools)) return null;
            return (
              <article key={serverId}>
                <h3>{typeof name === "string" ? name : serverId}</h3>
                {tools.map((tool) => {
                  if (typeof tool !== "object" || tool === null || typeof Reflect.get(tool, "name") !== "string")
                    return null;
                  const toolName = Reflect.get(tool, "name");
                  if (typeof toolName !== "string") return null;
                  return (
                    <label key={toolName}>
                      {toolName}
                      <select
                        aria-label={`Policy for ${toolName}`}
                        defaultValue="needs_grant"
                        onChange={(event) =>
                          void window.vibecab.command("vc.SetToolPolicy", {
                            serverId,
                            tools: { [toolName]: event.target.value },
                          })
                        }
                      >
                        <option value="allowed">Allowed</option>
                        <option value="needs_grant">Needs grant</option>
                        <option value="blocked">Blocked</option>
                      </select>
                    </label>
                  );
                })}
                <button
                  onClick={() =>
                    void window.vibecab
                      .command("vc.DisconnectToolServer", { serverId })
                      .then(() => window.vibecab.query<unknown[]>("vc.ToolServers", {}).then(setServers))
                  }
                >
                  Disconnect
                </button>
              </article>
            );
          })}
          <p>Recent tool calls</p>
          <pre>{JSON.stringify(toolCalls, null, 2)}</pre>
        </section>
      ) : null}
      {tab === "AI assistant (MCP)" ? (
        <section aria-label="AI assistant MCP">
          <p>Your own AI assistant can work with VibeCab as you.</p>
          {token ? (
            <>
              <label>
                MCP access token
                <input aria-label="MCP access token" readOnly value={token} />
              </label>
              <button
                onClick={() =>
                  void window.vibecab.app.copyText(
                    JSON.stringify(
                      { command: relayPath, env: { VIBECAB_WORKSPACE: workspace, VIBECAB_MCP_TOKEN: token } },
                      null,
                      2,
                    ),
                  )
                }
              >
                Copy
              </button>
              <button onClick={() => setToken("")}>Done</button>
              <pre>
                {JSON.stringify(
                  { command: relayPath, env: { VIBECAB_WORKSPACE: workspace, VIBECAB_MCP_TOKEN: token } },
                  null,
                  2,
                )}
              </pre>
              <button onClick={() => void window.vibecab.app.openMcpConfig()}>Open config file</button>
            </>
          ) : showTokenChoices ? (
            <>
              <button onClick={() => void createToken("read")}>Read only</button>
              <button onClick={() => void createToken("collaborate")}>Can comment and agree</button>
            </>
          ) : (
            <button onClick={() => setShowTokenChoices(true)}>Create access</button>
          )}
          <h3>Access tokens</h3>
          {tokens.map((item) => (
            <p key={item.tokenId}>
              {item.name} · {item.channel} · {item.scope}{" "}
              {item.revokedAt ? (
                "· Revoked"
              ) : item.channel === "mcp" ? (
                <button
                  onClick={() =>
                    void window.vibecab
                      .command("sys.RevokeAccessToken", { tokenId: item.tokenId })
                      .then(() => window.vibecab.query<typeof tokens>("sys.AccessTokens", {}).then(setTokens))
                  }
                >
                  Revoke
                </button>
              ) : null}
            </p>
          ))}
        </section>
      ) : null}
      {tab === "Data" ? (
        <section aria-label="Data settings">
          <p>Workspace: {workspace}</p>
          <button onClick={() => void window.vibecab.app.reveal(workspace)}>Reveal in Finder</button>
          <button
            onClick={() =>
              void window.vibecab
                .command("sys.Backup", {})
                .then((result) => setMessage(result.ok ? "Backup queued" : result.error.message))
            }
          >
            Back up now
          </button>
          <button
            onClick={() =>
              void window.vibecab.app
                .restoreBackup()
                .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Restore failed"))
            }
          >
            Restore from backup…
          </button>
          <label>
            Trash retention days
            <input
              aria-label="Trash retention days"
              type="number"
              min="1"
              max="3650"
              value={retentionDays}
              onChange={(event) => setRetentionDays(Number(event.target.value))}
            />
          </label>
          <button onClick={() => void saveSettings({ trashRetentionDays: retentionDays })}>Save retention</button>
          <h3>Backups</h3>
          {backups.map((raw, index) => (
            <p key={index}>
              {JSON.stringify(raw)}{" "}
              <button
                onClick={() => {
                  if (typeof raw === "object" && raw !== null && typeof Reflect.get(raw, "archivePath") === "string")
                    void window.vibecab.app.reveal(Reflect.get(raw, "archivePath"));
                }}
              >
                Reveal
              </button>
            </p>
          ))}
          <h3>Exports</h3>
          {exports.map((raw, index) => (
            <p key={index}>
              {JSON.stringify(raw)}{" "}
              <button
                onClick={() => {
                  if (typeof raw !== "object" || raw === null) return;
                  const target = Reflect.get(raw, "target"),
                    format = Reflect.get(raw, "format");
                  if (target && typeof format === "string")
                    void window.vibecab.command("vc.Export", { target, format });
                }}
              >
                Save again
              </button>
            </p>
          ))}
        </section>
      ) : null}
      {tab === "Appearance" ? <SettingsAppearance /> : null}
      {tab === "About" ? (
        <section aria-label="About">
          <p>VibeCab {version}</p>
          <p>Engine contract version 1</p>
          <p>Node {nodeVersion}</p>
          <button onClick={() => void window.vibecab.app.copyText(`vibecab --workspace "${workspace}"`)}>
            Copy CLI usage
          </button>
        </section>
      ) : null}
      <p role="status">{message}</p>
    </section>
  );
}
