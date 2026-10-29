import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, relative, resolve } from "node:path";
import { canonical } from "../content/hash.js";
import { BoundaryError, fail } from "../../../contract/src/index.js";
import type {
  Agreement,
  BackupManifest,
  CallContext,
  ExportRecord,
  FeedbackComment,
  Job,
  Json,
  Label,
  OutputSet,
  SessionDigest,
  TrashRecord,
} from "../../../contract/src/index.js";
import { LifecycleJobsRuntime } from "./jobs-runtime.js";

const runFile = promisify(execFile);
type TrashTarget = { kind: TrashRecord["kind"]; id: string };
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export class LifecycleRuntime extends LifecycleJobsRuntime {
  protected runEngineJob(kind: string, job: Job): Promise<void> {
    const handlers: Record<string, (current: Job) => Promise<void>> = {
      "agent.reply": (current) => this.runReply(current),
      "agent.trigger": (current) => this.runTrigger(current),
      "agent.update.trigger": (current) => this.runUpdateTrigger(current),
      "agent.update": (current) => this.runUpdate(current),
      "agent.tool_server.refresh": (current) => this.runToolServerRefresh(current),
      digest: (current) => this.runDigest(current),
      export: (current) => this.runExport(current),
      backup: (current) => this.runBackup(current),
      purge: (current) => this.runPurge(current),
      "trash.sweep": () => this.runTrashSweep(),
    };
    const handler = handlers[kind];
    if (!handler) fail("unsupported", `No job handler for ${kind}`);
    return handler(job);
  }

  async restoreBackup(archivePath: string, destinationDir: string): Promise<void> {
    if (this.store || this.lock || this.starting || this.accepting)
      fail("unavailable", "Stop the engine before restoring a backup");
    if (!archivePath || !destinationDir) fail("invalid", "Archive and destination paths are required");

    const archiveStat = await lstat(archivePath).catch(() => undefined);
    if (!archiveStat?.isFile() || archiveStat.isSymbolicLink())
      fail("invalid", "Backup archive must be a regular file");
    const absoluteDestination = resolve(destinationDir),
      destinationName = basename(absoluteDestination);
    if (!destinationName) fail("invalid", "Destination must name a workspace directory");
    const parent = await realpath(dirname(absoluteDestination)),
      destination = join(parent, destinationName);
    let destinationExists = false;
    try {
      const info = await lstat(destination);
      if (!info.isDirectory() || info.isSymbolicLink()) fail("invalid", "Restore destination must be a directory");
      if ((await readdir(destination)).length > 0) fail("conflict", "Restore destination must be empty");
      destinationExists = true;
    } catch (error) {
      if (field(error, "code") !== "ENOENT") throw error;
    }

    const staging = await mkdtemp(join(parent, `.${destinationName}.restore-`));
    try {
      const listing = await runFile("tar", ["-tzf", archivePath]),
        members = listing.stdout.split("\n").filter(Boolean);
      if (members.length === 0) fail("invalid", "Backup archive is empty");
      for (const member of members) {
        const normalized = member.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
        const allowed =
          normalized === "" ||
          normalized === "blobs" ||
          normalized === "workspace.sqlite" ||
          normalized === "manifest.json" ||
          /^blobs\/[a-f0-9]{2}(?:\/[a-f0-9]{2}(?:\/[a-f0-9]{60}(?:\.meta\.json)?)?)?$/.test(normalized);
        if (!allowed) fail("invalid", "Backup archive contains an unexpected path");
      }
      const details = await runFile("tar", ["-tvzf", archivePath]);
      if (
        details.stdout
          .split("\n")
          .filter(Boolean)
          .some((line) => !["d", "-"].includes(line[0] ?? ""))
      )
        fail("invalid", "Backup archive contains links or special files");
      await runFile("tar", ["-xzf", archivePath, "-C", staging]);

      const manifestBytes = await readFile(join(staging, "manifest.json")),
        decoded: unknown = JSON.parse(manifestBytes.toString("utf8")),
        manifest = this.contract.read<BackupManifest>("backup-manifest", decoded),
        actualFiles = (await this.listFiles(staging))
          .map((path) => relative(staging, path))
          .filter((path) => path !== "manifest.json")
          .sort(),
        expectedFiles = Object.keys(manifest.files).sort();
      if (
        !actualFiles.includes("workspace.sqlite") ||
        !actualFiles.every((path, index) => path === expectedFiles[index]) ||
        actualFiles.length !== expectedFiles.length
      )
        fail("invalid", "Backup manifest does not match the archive contents");
      for (const path of actualFiles) {
        const hash = createHash("sha256")
          .update(await readFile(join(staging, path)))
          .digest("hex");
        if (manifest.files[path] !== hash) fail("invalid", `Backup hash mismatch for ${path}`);
      }
      await lstat(join(staging, "blobs"));

      if (destinationExists) await rmdir(destination);
      else {
        try {
          await lstat(destination);
          fail("conflict", "Restore destination changed during validation");
        } catch (error) {
          if (field(error, "code") !== "ENOENT") throw error;
        }
      }
      await rename(staging, destination);
    } catch (error) {
      if (error instanceof BoundaryError) throw error;
      fail("invalid", "Backup archive could not be verified or extracted");
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  protected dispatchLifecycleCommand(name: string, raw: Json, ctx: CallContext): unknown {
    const store = this.available();
    switch (name) {
      case "vc.MarkSeen": {
        const p = this.contract.read<{ sessionId: string }>("operations/vc.MarkSeen", raw, "#/properties/payload");
        this.readSession(p.sessionId);
        const lastSeenSeq = store.lastSeq();
        store.saveFeedback(
          "session-seen",
          p.sessionId,
          this.contract.read<Json>("session-seen", {
            sessionId: p.sessionId,
            lastSeenSeq,
            updatedAt: this.deps.clock.now(),
          }),
        );
        this.event("session", p.sessionId, "seen");
        return { sessionId: p.sessionId, lastSeenSeq };
      }
      case "vc.CreateOutputSet": {
        const p = this.contract.read<{ sessionId?: string; label?: string; artifactIds: string[] }>(
          "operations/vc.CreateOutputSet",
          raw,
          "#/properties/payload",
        );
        if (ctx.principal.kind !== "human") fail("forbidden", "CreateOutputSet requires a human principal");
        if (p.sessionId) this.readSession(p.sessionId);
        const members = p.artifactIds.map((artifactId) => {
          this.assertLifecycleVisible("artifact", artifactId);
          if (p.sessionId && !store.feedback("attachment", `${p.sessionId}:${artifactId}`))
            fail("invalid", "Every Output Set artifact must be attached to its session");
          const artifact = store.artifact(artifactId),
            version = store.version(artifactId, artifact.headVersion);
          return {
            artifactId,
            version: version.version,
            manifestHash: createHash("sha256").update(canonical(version.manifest)).digest("hex"),
          };
        });
        const previous = store
          .feedbackList("output-set")
          .map((value) => this.contract.read<OutputSet>("output-set", value))
          .filter((set) => set.members.some((member) => p.artifactIds.includes(member.artifactId)));
        const agreementIds = store
          .feedbackList("agreement")
          .map((value) => this.contract.read<Agreement>("agreement", value))
          .filter((agreement) => {
            if (agreement.state !== "applied" || agreement.appliedVersion === undefined) return false;
            const commentRaw = store.feedback("comment", agreement.commentId);
            if (!commentRaw) return false;
            const comment = this.contract.read<FeedbackComment>("feedback-comment", commentRaw),
              artifactId = comment.anchor?.artifactId;
            if (!artifactId || !p.artifactIds.includes(artifactId)) return false;
            const current = members.find((member) => member.artifactId === artifactId);
            if (!current || agreement.appliedVersion > current.version) return false;
            const oldVersion = previous
              .flatMap((set) => set.members)
              .filter((member) => member.artifactId === artifactId)
              .reduce((max, member) => Math.max(max, member.version), 0);
            return agreement.appliedVersion > oldVersion;
          })
          .map((agreement) => agreement.agreementId);
        const outputSetId = this.deps.ids.next("output_");
        const outputSet = this.contract.read<OutputSet>("output-set", {
          outputSetId,
          ...(p.sessionId ? { sessionId: p.sessionId } : {}),
          ...(p.label ? { label: p.label } : {}),
          members,
          links: { agreementIds, reviewRequestIds: [] },
          createdAt: this.deps.clock.now(),
        });
        store.saveFeedback("output-set", outputSetId, this.contract.read<Json>("json", outputSet));
        this.event("output_set", outputSetId, "created");
        return { outputSetId };
      }
      case "vc.Label": {
        const p = this.contract.read<{ target: Label["target"]; label: string }>(
          "operations/vc.Label",
          raw,
          "#/properties/payload",
        );
        if (ctx.principal.kind !== "human") fail("forbidden", "Label requires a human principal");
        if ("outputSetId" in p.target) this.feedbackRecord<OutputSet>("output-set", "output-set", p.target.outputSetId);
        else store.version(p.target.artifactId, p.target.version);
        const label = this.contract.read<Label>("label", {
          labelId: this.deps.ids.next("label_"),
          target: p.target,
          label: p.label,
          createdAt: this.deps.clock.now(),
        });
        store.saveFeedback("label", label.labelId, this.contract.read<Json>("json", label));
        this.event("label", label.labelId, "created");
        return label;
      }
      case "vc.Export": {
        const p = this.contract.read<{
          target: { artifactId: string; version?: number } | { outputSetId: string };
          format: "markdown" | "html" | "json";
          include?: { threads?: boolean; decisionRecord?: boolean };
        }>("operations/vc.Export", raw, "#/properties/payload");
        if (ctx.principal.kind !== "human") fail("forbidden", "Export requires a human principal");
        this.validateExportTarget(p.target);
        const exportId = this.deps.ids.next("export_"),
          record = this.contract.read<ExportRecord>("export-record", {
            exportId,
            status: "queued",
            target: p.target,
            format: p.format,
            createdAt: this.deps.clock.now(),
          });
        store.saveFeedback("export", exportId, this.contract.read<Json>("json", record));
        store.saveFeedback("export-request", exportId, this.contract.read<Json>("json", p));
        store.enqueue("export", exportId, this.contract.read<Json>("json", { exportId }), this.deps.clock.now());
        this.event("export", exportId, "queued");
        return { exportId, status: "queued" };
      }
      case "vc.Trash": {
        const p = this.contract.read<{ target: TrashTarget }>("operations/vc.Trash", raw, "#/properties/payload");
        if (ctx.principal.kind !== "human") fail("forbidden", "Trash requires a human principal");
        this.validateTrashTarget(p.target);
        const key = this.trashKey(p.target),
          prior = store.feedback("trash", key);
        if (prior) fail("conflict", "Target is already trashed");
        const retentionDays = this.settings().trashRetentionDays ?? 30,
          trashedAt = this.deps.clock.now(),
          record = this.contract.read<TrashRecord>("trash-record", {
            ...p.target,
            trashedAt,
            purgeAt: new Date(Date.parse(trashedAt) + retentionDays * 86_400_000).toISOString(),
          });
        store.saveFeedback("trash", key, this.contract.read<Json>("json", record));
        this.event(p.target.kind, p.target.id, "trashed");
        return record;
      }
      case "vc.Restore": {
        const p = this.contract.read<{ target: TrashTarget }>("operations/vc.Restore", raw, "#/properties/payload");
        if (ctx.principal.kind !== "human") fail("forbidden", "Restore requires a human principal");
        const key = this.trashKey(p.target);
        if (!store.feedback("trash", key)) fail("not_found", "Trash record not found");
        store.deleteFeedback("trash", key);
        this.event(p.target.kind, p.target.id, "restored");
        return { restored: true };
      }
      case "vc.Purge": {
        const p = this.contract.read<{ target: TrashTarget }>("operations/vc.Purge", raw, "#/properties/payload");
        if (!store.feedback("trash", this.trashKey(p.target)))
          fail("conflict", "Target must be in the trash before purge");
        const purgeId = this.deps.ids.next("purge_");
        store.saveFeedback("purge-request", purgeId, this.contract.read<Json>("json", { target: p.target }));
        store.enqueue("purge", purgeId, this.contract.read<Json>("json", { purgeId }), this.deps.clock.now());
        this.event("purge", purgeId, "queued");
        return { purgeId, status: "queued" };
      }
      case "sys.Backup": {
        const p = this.contract.read<Record<string, never>>("operations/sys.Backup", raw, "#/properties/payload");
        void p;
        const backupId = this.deps.ids.next("backup_");
        store.saveFeedback(
          "backup",
          backupId,
          this.contract.read<Json>("backup-record", { backupId, status: "queued", createdAt: this.deps.clock.now() }),
        );
        store.enqueue("backup", backupId, this.contract.read<Json>("json", { backupId }), this.deps.clock.now());
        this.event("backup", backupId, "queued");
        return { backupId, status: "queued" };
      }
      case "vc.EditDigest": {
        const p = this.contract.read<{
          sessionId: string;
          purpose: string;
          whereItStands: string;
          openQuestions: string[];
          nextSteps: string[];
        }>("operations/vc.EditDigest", raw, "#/properties/payload");
        if (ctx.principal.kind !== "human") fail("forbidden", "EditDigest requires a human principal");
        this.readSession(p.sessionId);
        const prior = store
          .feedbackList("digest")
          .map((value) => this.contract.read<SessionDigest>("session-digest", value))
          .filter((digest) => digest.sessionId === p.sessionId)
          .reduce((max, digest) => Math.max(max, digest.version), 0);
        const digest = this.contract.read<SessionDigest>("session-digest", {
          digestId: this.deps.ids.next("digest_"),
          sessionId: p.sessionId,
          version: prior + 1,
          purpose: p.purpose,
          whereItStands: p.whereItStands,
          openQuestions: p.openQuestions,
          nextSteps: p.nextSteps,
          createdBy: "human",
          createdAt: this.deps.clock.now(),
        });
        store.saveFeedback("digest", digest.digestId, this.contract.read<Json>("json", digest));
        this.event("digest", digest.digestId, "edited");
        return digest;
      }
      default:
        fail("unsupported", "Operation is not supported");
    }
  }

  protected dispatchLifecycleQuery(name: string, raw: Json): unknown {
    const store = this.available();
    switch (name) {
      case "vc.Ideas":
      case "vc.Projects":
      case "vc.Sessions":
      case "vc.Threads":
      case "vc.FeedbackItems":
      case "vc.DecisionRecord":
      case "vc.Conflicts":
      case "vc.AttentionInbox":
        return this.filterTrashedQuery(name, raw, this.feedback!.query(name, raw));
      case "vc.OutputSets": {
        const p = this.contract.read<{ sessionId?: string }>("operations/vc.OutputSets", raw, "#/properties/payload");
        return store
          .feedbackList("output-set")
          .map((value) => this.contract.read<OutputSet>("output-set", value))
          .filter((set) => !p.sessionId || set.sessionId === p.sessionId);
      }
      case "vc.Labels": {
        const p = this.contract.read<{ outputSetId?: string; artifactId?: string }>(
          "operations/vc.Labels",
          raw,
          "#/properties/payload",
        );
        return store
          .feedbackList("label")
          .map((value) => this.contract.read<Label>("label", value))
          .filter((label) =>
            p.outputSetId
              ? "outputSetId" in label.target && label.target.outputSetId === p.outputSetId
              : !p.artifactId || ("artifactId" in label.target && label.target.artifactId === p.artifactId),
          );
      }
      case "vc.Exports": {
        this.contract.read("operations/vc.Exports", raw, "#/properties/payload");
        return store.feedbackList("export");
      }
      case "sys.Backups": {
        this.contract.read("operations/sys.Backups", raw, "#/properties/payload");
        return store.feedbackList("backup");
      }
      case "vc.Digest": {
        const p = this.contract.read<{ sessionId: string }>("operations/vc.Digest", raw, "#/properties/payload");
        this.readSession(p.sessionId);
        return store
          .feedbackList("digest")
          .map((value) => this.contract.read<SessionDigest>("session-digest", value))
          .filter((digest) => digest.sessionId === p.sessionId)
          .sort((a, b) => a.version - b.version);
      }
      case "vc.ResumeView":
        return this.resumeView(raw);
      case "vc.PurgePreview": {
        const p = this.contract.read<{ target: TrashTarget }>(
          "operations/vc.PurgePreview",
          raw,
          "#/properties/payload",
        );
        this.validateTrashTarget(p.target);
        return this.purgePreview(p.target);
      }
      default:
        fail("unsupported", "Operation is not supported");
    }
  }
}
