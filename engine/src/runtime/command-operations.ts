import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fail } from "../../../contract/src/index.js";
import type {
  CallContext,
  CommandEnvelope,
  Json,
  ProviderModel,
  FeedbackComment,
  Agreement,
  VcCreateArtifactOperation,
  VcImportContentOperation,
  VcRestoreVersionOperation,
  SysCreateAccessTokenOperation,
} from "../../../contract/src/index.js";
import { importContent } from "../content/import.js";
import { createGrant, revokeGrant } from "../agent/grants.js";
import type { SettingsDocument } from "../gateway/types.js";
import { StorageAccessRuntime } from "./storage-access.js";

export abstract class CommandOperations extends StorageAccessRuntime {
  protected dispatchOperationCommand(ctx: CallContext, cmd: CommandEnvelope): unknown {
    const content = this.content;
    const store = this.store;
    if (!content || !store) fail("unavailable", "Engine is stopped");
    switch (cmd.type) {
      case "sys.SetSettings": {
        const p = this.contract.read<{
          patch: {
            models?: Record<string, ProviderModel>;
            budgets?: SettingsDocument["budgets"];
            sessions?: Record<string, Json>;
          };
        }>("operations/sys.SetSettings", cmd.payload, "#/properties/payload");
        const current = this.settings(),
          budgets = { ...current.budgets, ...p.patch.budgets };
        if (budgets.localTimeZone !== undefined) {
          try {
            new Intl.DateTimeFormat("en", { timeZone: budgets.localTimeZone });
          } catch {
            fail("invalid", "Invalid local time zone");
          }
        }
        const settings = this.saveSettings({
          models: { ...current.models, ...p.patch.models },
          budgets,
          sessions: { ...current.sessions, ...p.patch.sessions },
        });
        store.appendEvent({
          ts: this.deps.clock.now(),
          type: "sys.SettingsChanged",
          entity: { kind: "settings", id: "workspace" },
          payload: this.contract.read<Json>("events/sys.SettingsChanged", {
            settings,
          }),
        });
        return { settings };
      }
      case "sys.SetProviderKeyRef": {
        const p = this.contract.read<{ alias: string; keyRef: string }>(
            "operations/sys.SetProviderKeyRef",
            cmd.payload,
            "#/properties/payload",
          ),
          current = this.settings(),
          model = current.models[p.alias];
        if (!model) fail("not_found", "Model alias not found");
        this.saveSettings({
          ...current,
          models: {
            ...current.models,
            [p.alias]: { ...model, keyRef: p.keyRef },
          },
        });
        store.appendEvent({
          ts: this.deps.clock.now(),
          type: "sys.ProviderKeyRefSet",
          entity: { kind: "model", id: p.alias },
          payload: this.contract.read<Json>("events/sys.ProviderKeyRefSet", p),
        });
        return p;
      }
      case "sys.SetBudget": {
        const p = this.contract.read<{
          account: {
            kind: "daily" | "session" | "grant" | "run" | "turn";
            key?: string;
          };
          limitMicros: number | null;
        }>("operations/sys.SetBudget", cmd.payload, "#/properties/payload");
        const budgets = this.budgets;
        if (!budgets) fail("unavailable", "Budget ledger is not started");
        const state = budgets.setLimit(p.account, p.limitMicros);
        store.appendEvent({
          ts: this.deps.clock.now(),
          type: "sys.BudgetChanged",
          entity: {
            kind: "budget",
            id: `${state.account.kind}:${state.account.key ?? ""}`,
          },
          payload: this.contract.read<Json>("events/sys.BudgetChanged", {
            account: state.account,
            limitMicros: state.limitMicros,
          }),
        });
        return { state };
      }
      case "sys.CreateAccessToken": {
        const p = this.contract.read<{
          name: string;
          channel: "http" | "cli" | "mcp";
          scope: "read" | "collaborate" | "admin";
        }>("operations/sys.CreateAccessToken", cmd.payload, "#/properties/payload");
        if (p.channel === "mcp" && p.scope === "admin") fail("invalid", "MCP access tokens cannot have admin scope");
        const token = randomBytes(32).toString("base64url"),
          accessToken = this.contract.read<SysCreateAccessTokenOperation["result"]["accessToken"]>("access-token", {
            tokenId: this.deps.ids.next("token_"),
            name: p.name,
            channel: p.channel,
            scope: p.scope,
            createdAt: this.deps.clock.now(),
          });
        store.createAccessToken({
          ...accessToken,
          secretHash: this.authentication.hash(token),
        });
        store.appendEvent({
          ts: accessToken.createdAt,
          type: "sys.AccessTokenCreated",
          entity: { kind: "access_token", id: accessToken.tokenId },
          payload: this.contract.read<Json>("events/sys.AccessTokenCreated", { accessToken }),
        });
        return { token, accessToken };
      }
      case "sys.RevokeAccessToken": {
        const p = this.contract.read<{ tokenId: string }>(
          "operations/sys.RevokeAccessToken",
          cmd.payload,
          "#/properties/payload",
        );
        store.revokeAccessToken(p.tokenId, this.deps.clock.now());
        store.appendEvent({
          ts: this.deps.clock.now(),
          type: "sys.AccessTokenRevoked",
          entity: { kind: "access_token", id: p.tokenId },
          payload: this.contract.read<Json>("events/sys.AccessTokenRevoked", { tokenId: p.tokenId }),
        });
        return { tokenId: p.tokenId, revoked: true };
      }
      case "vc.CreateArtifact": {
        const p = this.contract.read<VcCreateArtifactOperation["payload"]>(
          "operations/" + cmd.type,
          cmd.payload,
          "#/properties/payload",
        );
        return content.create(p.title, ctx.principal);
      }
      case "vc.ImportContent": {
        const p = this.contract.read<VcImportContentOperation["payload"]>(
          "operations/" + cmd.type,
          cmd.payload,
          "#/properties/payload",
        );
        if (p.format === "markdown")
          for (const change of importContent(p.content, p.format))
            if (change.element.type === "image") {
              const hash = change.element.blobHash,
                path = join(this.workspace, "blobs", hash.slice(0, 2), hash.slice(2, 4), hash);
              if (!existsSync(path)) fail("not_found", "Markdown image blob was not found in this workspace");
            }
        const r = content.import(p, ctx.principal);
        return {
          artifactId: r.artifactId,
          version: r.version,
          ...("idMap" in r ? { idMap: r.idMap } : {}),
        };
      }
      case "vc.RestoreVersion": {
        const p = this.contract.read<VcRestoreVersionOperation["payload"]>(
          "operations/" + cmd.type,
          cmd.payload,
          "#/properties/payload",
        );
        const r = content.restore(p.artifactId, p.version, ctx.principal);
        for (const agreement of store
          .feedbackList("agreement")
          .map((x) => this.contract.read<Agreement>("agreement", x))
          .filter((a) => a.state === "applied" && a.appliedVersion !== undefined && a.appliedVersion > p.version)) {
          const rawComment = store.feedback("comment", agreement.commentId);
          if (!rawComment) continue;
          const comment = this.contract.read<FeedbackComment>("feedback-comment", rawComment);
          if (comment.anchor?.artifactId !== p.artifactId) continue;
          store.saveFeedback(
            "agreement",
            agreement.agreementId,
            this.contract.read<Json>("agreement", {
              ...agreement,
              revertedInVersion: r.version,
            }),
          );
          this.feedback?.systemNotice(
            comment.sessionId,
            comment.threadId,
            `The Update applied in version ${agreement.appliedVersion} was reverted by restoring version ${p.version}. Re-agree if you still want this change.`,
          );
        }
        return { artifactId: r.artifactId, version: r.version };
      }
      case "vc.CaptureIdea":
      case "vc.CreateProject":
      case "vc.AttachArtifact":
      case "vc.ResumeSession":
      case "vc.EndSession":
      case "vc.Comment":
      case "vc.EditComment":
      case "vc.DeleteComment":
      case "vc.Agree":
      case "vc.Decline":
      case "vc.ResolveConflict":
      case "vc.SetReplyTrigger":
      case "vc.MarkHandled":
        if (!this.feedback) fail("unavailable", "Engine is stopped");
        return this.feedback.command(cmd.type, cmd.payload, ctx.principal, ctx.channel);
      case "vc.StartSession": {
        if (!this.feedback) fail("unavailable", "Engine is stopped");
        const result = this.feedback.command(cmd.type, cmd.payload, ctx.principal, ctx.channel),
          sessionId = this.contract.read<{ sessionId: string }>(
            "operations/vc.StartSession",
            result,
            "#/properties/result",
          ).sessionId,
          lastSeenSeq = store.lastSeq();
        store.saveFeedback(
          "session-seen",
          sessionId,
          this.contract.read<Json>("session-seen", { sessionId, lastSeenSeq, updatedAt: this.deps.clock.now() }),
        );
        return result;
      }
      case "vc.PauseSession": {
        if (!this.feedback) fail("unavailable", "Engine is stopped");
        const p = this.contract.read<{ sessionId: string }>(
            "operations/vc.PauseSession",
            cmd.payload,
            "#/properties/payload",
          ),
          result = this.feedback.command(cmd.type, cmd.payload, ctx.principal, ctx.channel),
          digestId = this.deps.ids.next("digest_");
        store.saveFeedback("digest-request", digestId, this.contract.read<Json>("json", { sessionId: p.sessionId }));
        store.enqueue(
          "digest",
          digestId,
          this.contract.read<Json>("json", { digestId, sessionId: p.sessionId }),
          this.deps.clock.now(),
        );
        return result;
      }
      case "vc.CreateGrant": {
        return createGrant(store, this.contract, this.deps.ids, ctx.principal, cmd.payload);
      }
      case "vc.RevokeGrant": {
        return revokeGrant(store, this.contract, this.deps.clock, ctx.principal, cmd.payload);
      }
      case "vc.AskAgent":
        if (ctx.principal.kind !== "human") fail("forbidden", "AskAgent requires a human principal");
        return this.askAgent(cmd.payload);
      case "vc.StartUpdate":
        if (ctx.principal.kind !== "human") fail("forbidden", "StartUpdate requires a human principal");
        return this.startUpdate(cmd.payload);
      case "vc.HoldElement": {
        if (ctx.principal.kind !== "human") fail("forbidden", "Direct editing requires a human principal");
        const p = this.contract.read<{ artifactId: string; elementId: string }>(
          "operations/vc.HoldElement",
          cmd.payload,
          "#/properties/payload",
        );
        if (!this.directEditingEnabled(p.artifactId)) fail("forbidden", "Direct editing is disabled for this artifact");
        if (this.activeUpdateTouches(p.artifactId, p.elementId))
          fail("locked", "Element is in an active Update write set");
        const element = store.elements(p.artifactId).find((x) => x.elementId === p.elementId);
        if (!element) fail("not_found", "Element not found");
        const key = `${p.artifactId}:${p.elementId}`,
          existing = store.feedback("hold", key);
        if (existing && this.activeHold(existing)) fail("locked", "Element is already held");
        const now = this.deps.clock.now();
        store.saveFeedback(
          "hold",
          key,
          this.contract.read<Json>("hold", {
            ...p,
            heldAt: now,
            lastActivity: now,
          }),
        );
        return { ...p, heldAt: now };
      }
      case "vc.SaveElement": {
        if (ctx.principal.kind !== "human") fail("forbidden", "Direct editing requires a human principal");
        const p = this.contract.read<{
          artifactId: string;
          elementId: string;
          baseVersion: number;
          element: import("../../../contract/src/index.js").ElementDraft;
        }>("operations/vc.SaveElement", cmd.payload, "#/properties/payload");
        if (!this.directEditingEnabled(p.artifactId)) fail("forbidden", "Direct editing is disabled for this artifact");
        if (this.activeUpdateTouches(p.artifactId, p.elementId))
          fail("locked", "Element is in an active Update write set");
        const key = `${p.artifactId}:${p.elementId}`,
          rawHold = store.feedback("hold", key);
        if (!rawHold || !this.activeHold(rawHold)) fail("locked", "A current element hold is required");
        const current = store.elements(p.artifactId, p.baseVersion).find((x) => x.elementId === p.elementId);
        if (!current) fail("not_found", "Element not found at base version");
        const committed = content.commit({
          artifactId: p.artifactId,
          baseVersion: p.baseVersion,
          changes: [{ op: "update", elementId: p.elementId, element: p.element }],
          createdBy: ctx.principal,
          source: { editId: this.deps.ids.next("edit_") },
        });
        const hold = this.contract.read<{
          artifactId: string;
          elementId: string;
          heldAt: string;
          lastActivity: string;
        }>("hold", rawHold);
        store.saveFeedback(
          "hold",
          key,
          this.contract.read<Json>("hold", {
            ...hold,
            lastActivity: this.deps.clock.now(),
          }),
        );
        return {
          artifactId: p.artifactId,
          elementId: p.elementId,
          version: committed.version,
        };
      }
      case "vc.ReleaseHold": {
        if (ctx.principal.kind !== "human") fail("forbidden", "Direct editing requires a human principal");
        const p = this.contract.read<{ artifactId: string; elementId: string }>(
            "operations/vc.ReleaseHold",
            cmd.payload,
            "#/properties/payload",
          ),
          key = `${p.artifactId}:${p.elementId}`,
          rawHold = store.feedback("hold", key);
        if (!rawHold) fail("not_found", "Element hold not found");
        const hold = this.contract.read<Record<string, Json>>("hold", rawHold);
        store.saveFeedback(
          "hold",
          key,
          this.contract.read<Json>("hold", {
            ...hold,
            releasedAt: this.deps.clock.now(),
          }),
        );
        return p;
      }
      case "vc.CancelUpdate":
        if (ctx.principal.kind !== "human") fail("forbidden", "CancelUpdate requires a human principal");
        return this.cancelUpdate(cmd.payload);
      case "vc.ApprovePlan":
        if (ctx.principal.kind !== "human") fail("forbidden", "ApprovePlan requires a human principal");
        return this.approvePlan(cmd.payload, cmd.commandId);
      default:
        return this.dispatchLifecycleCommand(cmd.type, cmd.payload, ctx);
    }
  }
}
