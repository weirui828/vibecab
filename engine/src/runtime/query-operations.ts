import { CONTRACT_VERSION, fail } from "../../../contract/src/index.js";
import type {
  QueryEnvelope,
  CallContext,
  AgentTurn,
  ContextManifest,
  Update,
  VcArtifactOperation,
  VcOutlineOperation,
  VcElementsOperation,
  VcDiffOperation,
  VcResolveAnchorsOperation,
  SessionArtifact,
} from "../../../contract/src/index.js";
import { unsupportedGroups } from "../../../contract/src/catalog.js";
import { outline, diffVersions, resolveAnchors } from "../content/diff.js";
import { CommandOperations } from "./command-operations.js";

export abstract class QueryOperations extends CommandOperations {
  protected dispatchOperationQuery(ctx: CallContext, q: QueryEnvelope): unknown {
    const store = this.available();
    const read = <T>() => this.contract.read<T>("operations/" + q.name, q.args, "#/properties/payload");
    switch (q.name) {
      case "sys.Capabilities": {
        read();
        const operations = [...this.contract.operations].map(([name, operation]) => ({
          name,
          ...operation,
          supported: true,
        }));
        for (const group of unsupportedGroups)
          for (const kind of ["command", "query"] satisfies ("command" | "query")[])
            for (const name of (kind === "command" ? group.commands : group.queries).split(" ").filter(Boolean)) {
              const effect = kind === "query" ? "read" : (group.effect ?? "collaborate");
              operations.push({
                name: group.prefix + "." + name,
                kind,
                supported: false,
                meta: {
                  effect,
                  irreversible: ["Purge", "RestoreBackup"].includes(name),
                  channels: effect === "admin" ? ["in_process", "http", "cli"] : ["in_process", "http", "cli", "mcp"],
                },
              });
            }
        return {
          contractVersion: CONTRACT_VERSION,
          callContext: { channel: ctx.channel, scope: ctx.scope },
          mediaKinds: ["doc", "html"],
          operations,
        };
      }
      case "vc.Artifact": {
        const p = read<VcArtifactOperation["payload"]>();
        this.assertLifecycleVisible("artifact", p.artifactId, p.includeTrashed);
        return store.artifact(p.artifactId);
      }
      case "vc.Artifacts": {
        const p = this.contract.read<{ sessionId?: string; includeTrashed?: boolean }>(
            "operations/vc.Artifacts",
            q.args,
            "#/properties/payload",
          ),
          links = store
            .feedbackList("attachment")
            .map((raw) => this.contract.read<SessionArtifact>("session-artifact", raw)),
          ids = p.sessionId
            ? links.filter((link) => link.sessionId === p.sessionId).map((link) => link.artifactId)
            : store.artifactIds();
        const projects = store
          .feedbackList("project")
          .map((raw) => this.contract.read<{ projectId: string; artifactIds?: string[] }>("project", raw));
        return [...new Set(ids)]
          .filter((artifactId) => p.includeTrashed === true || !this.isLifecycleTrashed("artifact", artifactId))
          .map((artifactId) => {
            const artifact = store.artifact(artifactId),
              related = links.filter((link) => link.artifactId === artifactId);
            const role = related.find((link) => link.sessionId === p.sessionId)?.role;
            return {
              ...artifact,
              sessionIds: related.map((link) => link.sessionId),
              projectIds: projects
                .filter((project) => project.artifactIds?.includes(artifactId))
                .map((p) => p.projectId),
              ...(role ? { role } : {}),
            };
          })
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
      case "vc.Outline": {
        const p = read<VcOutlineOperation["payload"]>();
        this.assertLifecycleVisible("artifact", p.artifactId, p.includeTrashed);
        return outline(store.elements(p.artifactId, p.version));
      }
      case "vc.Elements": {
        const p = read<VcElementsOperation["payload"]>(),
          elements = store.elements(p.artifactId, p.version);
        this.assertLifecycleVisible("artifact", p.artifactId, p.includeTrashed);
        return p.elementIds ? elements.filter((e) => p.elementIds!.includes(e.elementId)) : elements;
      }
      case "vc.Versions": {
        const p = read<VcArtifactOperation["payload"]>();
        this.assertLifecycleVisible("artifact", p.artifactId, p.includeTrashed);
        const sets = store
          .feedbackList("output-set")
          .map((value) =>
            this.contract.read<{ outputSetId: string; members: Array<{ artifactId: string; version: number }> }>(
              "output-set",
              value,
            ),
          );
        return store.versions(p.artifactId).map((version) => ({
          ...version,
          outputSetIds: sets
            .filter((set) =>
              set.members.some((member) => member.artifactId === p.artifactId && member.version === version.version),
            )
            .map((set) => set.outputSetId),
        }));
      }
      case "vc.Diff": {
        const p = read<VcDiffOperation["payload"]>();
        this.assertLifecycleVisible("artifact", p.artifactId, p.includeTrashed);
        return diffVersions(store, p.artifactId, p.from, p.to);
      }
      case "vc.ResolveAnchors":
        return resolveAnchors(store, read<VcResolveAnchorsOperation["payload"]>().anchors);
      case "sys.Settings":
        read();
        return this.settings();
      case "sys.Usage": {
        read();
        const budgets = this.budgets;
        if (!budgets) fail("unavailable", "Budget ledger is not started");
        return { accounts: budgets.states(), calls: budgets.calls() };
      }
      case "sys.UsageStats": {
        const p = read<{ from: string; to: string; groupBy: "day" | "agent" | "model" | "session" | "purpose" }>();
        const budgets = this.budgets;
        if (!budgets) fail("unavailable", "Budget ledger is not started");
        return budgets.stats(p.from, p.to, p.groupBy);
      }
      case "sys.SpendingToday": {
        read();
        const budgets = this.budgets;
        if (!budgets) fail("unavailable", "Budget ledger is not started");
        return budgets.today(Object.keys(this.settings().models));
      }
      case "sys.Budgets": {
        read();
        const budgets = this.budgets;
        if (!budgets) fail("unavailable", "Budget ledger is not started");
        return budgets.states();
      }
      case "sys.AccessTokens": {
        read();
        return store.accessTokens().map(({ tokenId, name, channel, scope, createdAt, revokedAt }) => ({
          tokenId,
          name,
          channel,
          scope,
          createdAt,
          ...(revokedAt ? { revokedAt } : {}),
        }));
      }
      case "vc.Ideas":
      case "vc.Projects":
      case "vc.Sessions":
      case "vc.Threads":
      case "vc.FeedbackItems":
      case "vc.DecisionRecord":
      case "vc.Conflicts":
      case "vc.AttentionInbox":
        if (!this.feedback) fail("unavailable", "Engine is stopped");
        return this.dispatchLifecycleQuery(q.name, q.args);
      case "vc.AgentTurns":
      case "vc.Manifest":
      case "vc.DeliveryState":
      case "vc.Grants":
      case "vc.ToolServers":
      case "vc.ToolCalls": {
        this.contract.read("operations/" + q.name, q.args, "#/properties/payload");
        if (q.name === "vc.AgentTurns") {
          const p = this.contract.read<{ sessionId?: string }>(
            "operations/vc.AgentTurns",
            q.args,
            "#/properties/payload",
          );
          return store
            .feedbackList("agent-turn")
            .map((x) => this.contract.read<AgentTurn>("agent-turn", x))
            .filter((x) => !p.sessionId || x.sessionId === p.sessionId);
        }
        if (q.name === "vc.Manifest") {
          const p = this.contract.read<{ turnId: string }>("operations/vc.Manifest", q.args, "#/properties/payload");
          return store
            .feedbackList("manifest")
            .map((x) => this.contract.read<ContextManifest>("context-manifest", x))
            .filter((x) => x.turnId === p.turnId);
        }
        if (q.name === "vc.Grants") return store.feedbackList("grant");
        if (q.name === "vc.ToolServers") {
          const p = this.contract.read<{ serverId?: string }>(
            "operations/vc.ToolServers",
            q.args,
            "#/properties/payload",
          );
          return store
            .feedbackList("tool-server")
            .map((x) => this.contract.read<import("../../../contract/src/index.js").ToolServer>("tool-server", x))
            .filter((server) => p.serverId === undefined || server.serverId === p.serverId)
            .map(({ serverId, name, scope, status, tools, policies, updatedAt }) => ({
              serverId,
              name,
              scope,
              status,
              tools,
              policies,
              updatedAt,
            }));
        }
        if (q.name === "vc.ToolCalls") {
          const p = this.contract.read<{ serverId?: string; turnId?: string }>(
            "operations/vc.ToolCalls",
            q.args,
            "#/properties/payload",
          );
          return store
            .feedbackList("tool-call")
            .map((x) => this.contract.read<import("../../../contract/src/index.js").ToolCall>("tool-call", x))
            .filter(
              (call) =>
                (p.serverId === undefined || call.serverId === p.serverId) &&
                (p.turnId === undefined || call.turnId === p.turnId),
            );
        }
        const p = this.contract.read<{ commentIds: string[] }>(
          "operations/vc.DeliveryState",
          q.args,
          "#/properties/payload",
        );
        return p.commentIds.map(
          (commentId) =>
            store.feedback("delivery-state", commentId) ?? {
              commentId,
              state: "saved",
              updatedAt: this.deps.clock.now(),
            },
        );
      }
      case "vc.Updates":
      case "vc.UpdateDetail": {
        if (q.name === "vc.Updates") {
          const p = this.contract.read<{ artifactId?: string }>(
            "operations/vc.Updates",
            q.args,
            "#/properties/payload",
          );
          const updates = store
            .feedbackList("update")
            .map((x) => this.contract.read<Update>("update", x))
            .filter((x) => !p.artifactId || x.artifactId === p.artifactId);
          const scheduledAt = store
            .jobs()
            .filter((job) => job.kind === "agent.update.trigger" && job.state === "pending")
            .flatMap((job) => {
              if (typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) return [];
              const artifactId = Reflect.get(job.payload, "artifactId"),
                notBefore = Reflect.get(job.payload, "notBefore");
              return typeof notBefore === "string" && (!p.artifactId || artifactId === p.artifactId) ? [notBefore] : [];
            })
            .sort()[0];
          return { updates, ...(scheduledAt ? { scheduledAt } : {}) };
        }
        const p = this.contract.read<{ updateId: string }>(
          "operations/vc.UpdateDetail",
          q.args,
          "#/properties/payload",
        );
        const found = store.feedback("update", p.updateId);
        if (!found) fail("not_found", "Update not found");
        return this.contract.read<Update>("update", found);
      }
      default:
        return this.dispatchLifecycleQuery(q.name, q.args);
    }
  }
}
