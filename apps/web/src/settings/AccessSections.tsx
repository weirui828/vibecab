import { useState } from "react";
import { Button, Field, Input } from "@wei/design-system";
import type { Grant } from "../../../../contract/generated/index.js";
import { terms } from "../../../ui/src/copy/terms.js";
import { useLiveQuery } from "../live/LiveStore.js";
import type { SessionRow } from "../live/workspace.js";
import { relativeTime } from "../ui/time.js";
import { Section, useRun } from "./common.js";

const capabilityWords: Record<string, string> = {
  auto_agree_own_proposals: "Its own proposals count as agreed",
  start_review: "Start reviews",
  create_output_set: `Save ${terms.snapshot.toLowerCase()}s`,
  use_tool: "Use connected tools",
};

export function GrantsSection({ sessions }: { sessions: SessionRow[] }) {
  const grants = useLiveQuery<Grant[]>("vc.Grants", {}),
    run = useRun();
  const live = (grants.data ?? []).filter((g) => !g.revokedAt);
  const titles = new Map(sessions.map((s) => [s.sessionId, s.title]));
  return (
    <Section
      id="permissions"
      level={3}
      title="What it may do"
      lede="Permissions you have given the agent. Taking one back is immediate."
    >
      {live.length === 0 ? (
        <p className="vc-muted">Nothing beyond replying and writing what you agree to.</p>
      ) : (
        <ul className="vc-plain-list">
          {live.map((g) => (
            <li key={g.grantId}>
              <span className="what">
                {(g.capabilities ?? []).map((c) => capabilityWords[c] ?? c).join(", ")}
                <span className="vc-facts">
                  {g.scope?.sessionIds?.length
                    ? "in " + g.scope.sessionIds.map((id) => titles.get(id) ?? terms.session).join(", ")
                    : "everywhere"}
                  {g.expiresAt ? ` · until ${new Date(g.expiresAt).toLocaleDateString()}` : ""}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void run("vc.RevokeGrant", { grantId: g.grantId })}>
                Take back
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

interface ToolServer {
  serverId: string;
  name: string;
  status: "connecting" | "connected" | "failed" | "disconnected";
  tools?: Array<{ name: string; description?: string }>;
  policies?: Record<string, "allowed" | "needs_grant" | "blocked">;
}
const policyWords = { allowed: "Allowed", needs_grant: "Ask first", blocked: "Blocked" } as const;

export function ToolsSection() {
  const servers = useLiveQuery<ToolServer[]>("vc.ToolServers", {}),
    run = useRun(),
    [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [target, setTarget] = useState("");
  const live = (servers.data ?? []).filter((s) => s.status !== "disconnected");
  async function connect() {
    const value = target.trim();
    if (!name.trim() || !value) return;
    const transport = /^https?:\/\//.test(value)
      ? { kind: "http", url: value }
      : { kind: "stdio", command: value.split(/\s+/)[0], args: value.split(/\s+/).slice(1) };
    if (await run("vc.ConnectToolServer", { name: name.trim(), transport })) {
      setAdding(false);
      setName("");
      setTarget("");
    }
  }
  return (
    <Section
      id="tools"
      level={3}
      title="Its tools"
      lede="MCP servers the agent connects to — VibeCab as an MCP client — and what it may do with each tool."
    >
      {live.map((server) => (
        <div key={server.serverId} className="vc-tool-server">
          <div className="head">
            <span
              className="vc-mound"
              data-tone={server.status === "connected" ? "active" : server.status === "failed" ? "danger" : "agent"}
              aria-hidden="true"
            />
            <strong>{server.name}</strong>
            <span className="vc-facts">{server.status}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void run("vc.DisconnectToolServer", { serverId: server.serverId })}
            >
              Disconnect
            </Button>
          </div>
          {(server.tools ?? []).map((tool) => (
            <label key={tool.name} className="vc-tool">
              <span>
                <span className="name">{tool.name}</span>
                {tool.description && <span className="vc-muted"> — {tool.description}</span>}
              </span>
              <select
                className="vc-select small"
                value={server.policies?.[tool.name] ?? "needs_grant"}
                onChange={(e) =>
                  void run("vc.SetToolPolicy", { serverId: server.serverId, tools: { [tool.name]: e.target.value } })
                }
              >
                {Object.entries(policyWords).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ))}
      {adding ? (
        <form
          className="vc-form"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <Field label="Name">
            <Input value={name} placeholder="Notes" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Command or address" hint="A command that starts the server, or its https:// address.">
            <Input value={target} placeholder="npx -y @acme/notes-mcp" onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <div className="vc-form-actions">
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="secondary">
              Connect
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          Connect a tool server
        </Button>
      )}
    </Section>
  );
}

interface AccessToken {
  tokenId: string;
  name: string;
  channel: "http" | "cli" | "mcp";
  scope: "read" | "collaborate" | "admin";
  createdAt: string;
  revokedAt?: string;
}

/**
 * Outside AI assistants working in VibeCab as the person, through VibeCab's MCP server: one row each with what it
 * may do and Revoke, then the way to connect another (its access key shows once).
 */
export function AssistantSection({ workspace, relayPath }: { workspace: string; relayPath: string | undefined }) {
  const tokens = useLiveQuery<AccessToken[]>("sys.AccessTokens", {}),
    run = useRun(),
    [created, setCreated] = useState<string>(),
    [copied, setCopied] = useState(false);
  const mcp = (tokens.data ?? []).filter((t) => t.channel === "mcp" && !t.revokedAt);
  async function create(scope: "read" | "collaborate") {
    const result = await run<{ token: string }>("sys.CreateAccessToken", {
      name: scope === "read" ? "Assistant (read only)" : "Assistant",
      channel: "mcp",
      scope,
    });
    if (result) {
      setCreated(result.token);
      setCopied(false);
    }
  }
  const config =
    created &&
    JSON.stringify(
      {
        mcpServers: {
          vibecab: {
            command: "node",
            args: [relayPath ?? "<path to vibecab-mcp.mjs>"],
            env: { VIBECAB_WORKSPACE: workspace, VIBECAB_MCP_TOKEN: created },
          },
        },
      },
      null,
      2,
    );
  return (
    <>
      <Section id="assistants" level={3} title="Connected">
        {mcp.length === 0 ? (
          <p className="vc-muted">None yet.</p>
        ) : (
          <ul className="vc-plain-list">
            {mcp.map((t) => (
              <li key={t.tokenId}>
                <span className="what">
                  {t.name}
                  <span className="vc-facts">
                    {t.scope === "read" ? "may read" : "may read, comment and agree"} · connected{" "}
                    {relativeTime(t.createdAt)}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void run("sys.RevokeAccessToken", { tokenId: t.tokenId })}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section
        id="assistant"
        level={3}
        title="Connect an assistant"
        lede="It gets its own access key. Paste the setup into the assistant's MCP settings."
      >
        {config ? (
          <div className="vc-secret">
            <p className="vc-muted">The access key is shown only now.</p>
            <pre>{config}</pre>
            <div className="vc-form-actions">
              <Button
                variant="secondary"
                onClick={() => void navigator.clipboard?.writeText(config).then(() => setCopied(true))}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="ghost" onClick={() => setCreated(undefined)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="vc-form-actions start">
            <Button variant="secondary" disabled={!workspace} onClick={() => void create("collaborate")}>
              Give access to comment and agree
            </Button>
            <Button variant="ghost" disabled={!workspace} onClick={() => void create("read")}>
              Read only
            </Button>
          </div>
        )}
      </Section>
    </>
  );
}

interface Backup {
  backupId: string;
  status: "queued" | "completed" | "failed";
  archivePath?: string;
  createdAt: string;
}

export function DataSection({ workspace, retention }: { workspace: string; retention: number | undefined }) {
  const backups = useLiveQuery<Backup[]>("sys.Backups", {}),
    run = useRun(),
    [days, setDays] = useState<string>();
  const list = [...(backups.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  return (
    <Section id="data" title="Your data" lede="Everything lives in one folder on this computer.">
      <p className="vc-path">
        <code>{workspace}</code>
      </p>
      <div className="vc-form-actions start">
        <Button variant="secondary" onClick={() => void run("sys.Backup", {}).then(() => backups.refresh())}>
          Back up now
        </Button>
      </div>
      {list.length > 0 && (
        <ul className="vc-plain-list">
          {list.map((b) => (
            <li key={b.backupId}>
              <span className="what">
                {b.status === "completed" ? "Backup" : b.status === "failed" ? "Backup failed" : "Backing up…"}
                <span className="vc-facts">
                  {relativeTime(b.createdAt)}
                  {b.archivePath ? ` · ${b.archivePath}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="vc-inline-setting"
        onSubmit={(e) => {
          e.preventDefault();
          const value = Number(days);
          if (Number.isInteger(value) && value >= 1)
            void run("sys.SetSettings", { patch: { trashRetentionDays: value } });
        }}
      >
        <Field label="Keep things in Trash for (days)">
          <Input
            inputMode="numeric"
            value={days ?? String(retention ?? 30)}
            onChange={(e) => setDays(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="ghost" disabled={days === undefined}>
          Save
        </Button>
      </form>
      <p className="vc-muted small">
        Restoring a backup replaces this workspace; run <code>vibecab-host restore</code> while VibeCab is stopped.
      </p>
    </Section>
  );
}
