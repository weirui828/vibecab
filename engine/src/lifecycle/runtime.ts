import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative } from "node:path";

import { canonical } from "../content/hash.js";
import { estimateInputTokens, estimateReservationMicros } from "../gateway/ledger.js";
import type { ModelRequest } from "../gateway/types.js";
import { CONTRACT_VERSION, fail } from "../../../contract/src/index.js";
import type {
  Agreement,
  CallContext,
  ContextManifest,
  DigestContent,
  Element,
  ExportRecord,
  FeedbackComment,
  Job,
  Json,
  Label,
  OutputSet,
  Session,
  SessionDigest,
  SessionSeen,
  TrashRecord,
  Update,
  Version,
} from "../../../contract/src/index.js";

import { UpdateRuntime } from "../updates/runtime.js";
import { renderHtmlDocument, renderHtmlFragment, renderMarkdown } from "./render.js";

const runFile = promisify(execFile);
type TrashTarget = TrashRecord["kind"] extends never ? never : { kind: TrashRecord["kind"]; id: string };
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export class LifecycleRuntime extends UpdateRuntime {
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

  protected async runExport(job: Job): Promise<void> {
    const exportId = this.jobId(job, "exportId"),
      record = this.feedbackRecord<ExportRecord>("export", "export-record", exportId);
    if (record.status === "completed") return;
    const request = this.feedbackRecord<{
      target: { artifactId: string; version?: number } | { outputSetId: string };
      format: "markdown" | "html" | "json";
      include?: { threads?: boolean; decisionRecord?: boolean };
    }>("export-request", "json", exportId);
    const members = this.exportMembers(request.target),
      documents = members.map((member) => ({
        artifact: this.available().artifact(member.artifactId),
        version: this.available().version(member.artifactId, member.version),
        elements: this.available().elements(member.artifactId, member.version),
      }));
    let content: string;
    if (request.format === "markdown")
      content = documents.map((document) => renderMarkdown(document.elements)).join("\n\n---\n\n");
    else if (request.format === "html") {
      const imageSources = await this.loadImageSources(documents.flatMap((document) => document.elements));
      const body = documents
        .map(
          (document) =>
            `<section><h1>${escapeHtml(document.artifact.title)}</h1>${renderHtmlFragment(document.elements, imageSources)}</section>`,
        )
        .join("\n");
      content = renderHtmlDocument(body);
    } else {
      const sessionIds = this.exportSessionIds(request.target),
        threads = request.include?.threads
          ? this.exportThreads(
              sessionIds,
              documents.map((d) => d.artifact.artifactId),
            )
          : [],
        agreements = request.include?.decisionRecord
          ? this.exportAgreements(documents.map((d) => d.artifact.artifactId))
          : undefined;
      content = canonical({
        documents: documents.map(({ artifact, version, elements }) => ({
          artifact: this.contract.read("operations/vc.Artifact", artifact, "#/properties/result"),
          version: this.contract.read("version", version),
          elements: elements.map((element) => this.contract.read<Element>("element", element)),
        })),
        ...(request.include?.threads ? { threads } : {}),
        ...(agreements ? { agreements } : {}),
      });
    }
    const blobHash = await this.putBlob(
      this.internalContext(`export:${exportId}`),
      new TextEncoder().encode(content),
      "text/plain; charset=utf-8",
    );
    await this.queue.run(() =>
      this.available().transaction(() => {
        const current = this.feedbackRecord<ExportRecord>("export", "export-record", exportId);
        this.available().saveFeedback(
          "export",
          exportId,
          this.contract.read<Json>("json", { ...current, status: "completed", blobHash }),
        );
        this.event("export", exportId, "completed");
      }),
    );
  }

  protected async runBackup(job: Job): Promise<void> {
    const backupId = this.jobId(job, "backupId"),
      current = this.feedbackRecord<Record<string, Json>>("backup", "json", backupId);
    if (current.status === "completed") return;
    const root = await mkdtemp(join(this.workspace, ".backup-")),
      outputDir = join(this.workspace, "exports"),
      archivePath = join(outputDir, `${backupId}.tar.gz`);
    await mkdir(outputDir, { recursive: true });
    try {
      await this.available().backup(join(root, "workspace.sqlite"));
      const blobs = join(this.workspace, "blobs");
      await cp(blobs, join(root, "blobs"), { recursive: true, force: true }).catch(async () =>
        mkdir(join(root, "blobs"), { recursive: true }),
      );
      const files = await this.listFiles(root),
        hashes: Record<string, string> = {};
      for (const path of files)
        hashes[relative(root, path)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      await writeFile(join(root, "manifest.json"), canonical({ format: 1, files: hashes }), { mode: 0o600 });
      await runFile("tar", ["-czf", archivePath, "-C", root, "."]);
      const archiveHash = createHash("sha256")
        .update(await readFile(archivePath))
        .digest("hex");
      await this.queue.run(() =>
        this.available().transaction(() => {
          this.available().saveFeedback(
            "backup",
            backupId,
            this.contract.read<Json>("json", { ...current, status: "completed", archivePath, archiveHash }),
          );
          this.event("backup", backupId, "completed");
        }),
      );
    } catch (error) {
      await rm(archivePath, { force: true });
      throw error;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  protected async runPurge(job: Job): Promise<void> {
    const purgeId = this.jobId(job, "purgeId"),
      request = this.feedbackRecord<{ target: TrashTarget }>("purge-request", "json", purgeId),
      preview = this.purgePreview(request.target),
      commentIds = new Set(preview.commentIds),
      artifactId = request.target.kind === "artifact" ? request.target.id : undefined,
      discardedBlobs = new Set<string>();
    await this.queue.run(() =>
      this.available().transaction(() => {
        for (const commentId of commentIds) {
          this.available().deleteFeedback("comment", commentId);
          for (const agreement of this.available()
            .feedbackList("agreement")
            .map((value) => this.contract.read<Agreement>("agreement", value)))
            if (agreement.commentId === commentId) this.available().deleteFeedback("agreement", agreement.agreementId);
        }
        for (const id of preview.agreementIds) this.available().deleteFeedback("agreement", id);
        for (const id of preview.digestIds) {
          this.available().deleteFeedback("digest", id);
          this.available().deleteFeedback("session-digest", id);
        }
        for (const id of preview.conflictIds) this.available().deleteFeedback("conflict", id);
        for (const id of preview.outputSetIds) {
          this.available().deleteFeedback("output-set", id);
          for (const value of this.available().feedbackList("label"))
            if (field(field(value, "target"), "outputSetId") === id) {
              const labelId = field(value, "labelId");
              if (typeof labelId === "string") this.available().deleteFeedback("label", labelId);
            }
        }
        if (artifactId) {
          for (const version of this.available().versions(artifactId))
            for (const element of this.available().elements(artifactId, version.version))
              if (element.type === "image") discardedBlobs.add(element.blobHash);
          for (const value of this.available().feedbackList("attachment")) {
            const link = this.contract.read<{ sessionId: string; artifactId: string }>("session-artifact", value);
            if (link.artifactId === artifactId)
              this.available().deleteFeedback("attachment", `${link.sessionId}:${link.artifactId}`);
          }
          for (const kind of ["update", "hold", "review-request", "review-snapshot"])
            for (const value of this.available().feedbackList(kind))
              if (field(value, "artifactId") === artifactId) {
                const id = field(value, "updateId") ?? field(value, "holdId") ?? field(value, "requestId");
                if (typeof id === "string") this.available().deleteFeedback(kind, id);
              }
          this.available().deleteArtifact(artifactId);
        } else if (request.target.kind === "comment") {
          this.available().deleteFeedback("comment", request.target.id);
        } else if (request.target.kind === "session") {
          for (const kind of [
            "session",
            "session-seen",
            "session-digest",
            "digest",
            "attachment",
            "agent-turn",
            "manifest",
            "delivery-state",
            "reply-trigger",
          ])
            for (const value of this.available().feedbackList(kind)) {
              const id = this.recordId(kind, value);
              if (field(value, "sessionId") === request.target.id && id) this.available().deleteFeedback(kind, id);
            }
        } else {
          const kind = request.target.kind === "idea" ? "idea" : "project";
          this.available().deleteFeedback(kind, request.target.id);
        }
        this.available().deleteFeedback("trash", this.trashKey(request.target));
        this.available().deleteFeedback("purge-request", purgeId);
        this.event("purge", purgeId, "completed");
      }),
    );
    for (const hash of discardedBlobs) {
      const retained = this.available()
        .artifactIds()
        .some((id) =>
          this.available()
            .elements(id)
            .some((element) => element.type === "image" && element.blobHash === hash),
        );
      if (!retained) {
        await rm(this.blobPath(hash), { force: true });
        await rm(`${this.blobPath(hash)}.meta.json`, { force: true });
      }
    }
  }

  protected ensureTrashSweep(): void {
    const jobs = this.available().jobs();
    if (jobs.some((job) => job.kind === "trash.sweep" && ["pending", "leased"].includes(job.state))) return;
    const id = this.deps.ids.next("trash_sweep_");
    this.available().enqueue("trash.sweep", id, this.contract.read<Json>("json", {}), this.deps.clock.now());
  }

  protected async runTrashSweep(): Promise<void> {
    const now = Date.parse(this.deps.clock.now());
    await this.queue.run(() =>
      this.available().transaction(() => {
        for (const value of this.available().feedbackList("trash")) {
          const record = this.contract.read<TrashRecord>("trash-record", value);
          if (Date.parse(record.purgeAt) > now) continue;
          const target: TrashTarget = { kind: record.kind, id: record.id };
          const alreadyQueued = this.available()
            .feedbackList("purge-request")
            .some((request) => {
              const requestTarget = field(request, "target");
              return field(requestTarget, "id") === target.id && field(requestTarget, "kind") === target.kind;
            });
          if (alreadyQueued) continue;
          const purgeId = this.deps.ids.next("purge_");
          this.available().saveFeedback("purge-request", purgeId, this.contract.read<Json>("json", { target }));
          this.available().enqueue(
            "purge",
            purgeId,
            this.contract.read<Json>("json", { purgeId }),
            this.deps.clock.now(),
          );
        }
        const id = this.deps.ids.next("trash_sweep_");
        this.available().enqueue(
          "trash.sweep",
          id,
          this.contract.read<Json>("json", {}),
          new Date(now + 86_400_000).toISOString(),
        );
      }),
    );
  }

  protected async runDigest(job: Job): Promise<void> {
    const digestId = this.jobId(job, "digestId"),
      sessionId = this.jobId(job, "sessionId");
    if (this.available().feedback("digest", digestId)) return;
    const settings = this.settings(),
      alias = settings.models.digest ? "digest" : settings.models.default ? "default" : undefined,
      model = alias ? settings.models[alias] : undefined;
    if (!alias || !model || !this.gateway || !this.budgets) fail("unsupported", "Digest model is not configured");
    const prompt = await readFile(new URL("../agent/prompts/digest.md", import.meta.url), "utf8"),
      session = this.readSession(sessionId),
      artifacts = this.available()
        .feedbackList("attachment")
        .map((value) => this.contract.read<{ sessionId: string; artifactId: string }>("session-artifact", value))
        .filter((value) => value.sessionId === sessionId)
        .map(({ artifactId }) => ({
          artifact: this.available().artifact(artifactId),
          version: this.available().version(artifactId),
        })),
      comments = this.available()
        .feedbackList("comment")
        .map((value) => this.contract.read<FeedbackComment>("feedback-comment", value))
        .filter((comment) => comment.sessionId === sessionId && !comment.deleted)
        .map(({ commentId, author, body, state }) => ({ commentId, author, body, state })),
      agreements = this.available()
        .feedbackList("agreement")
        .map((value) => this.contract.read<Agreement>("agreement", value))
        .filter((agreement) => comments.some((comment) => comment.commentId === agreement.commentId)),
      messages = [
        { role: "system" as const, content: prompt },
        { role: "user" as const, content: canonical({ session, artifacts, comments, agreements }) },
      ],
      request: ModelRequest = {
        modelRef: alias,
        messages,
        output: { kind: "json", schema: this.contract.schema("digest-content"), name: "digest-content" },
        maxOutputTokens: Math.min(
          1500,
          settings.sessions[sessionId]?.tokenLimit ?? settings.budgets.defaultTurnTokenLimit ?? 8192,
        ),
      };
    if (estimateInputTokens(request) + request.maxOutputTokens > model.capabilities.maxContextTokens)
      fail("budget_exceeded", "Digest context exceeds the model context window");
    const manifestId = this.deps.ids.next("manifest_"),
      promptHash = createHash("sha256").update(prompt).digest("hex"),
      manifest = this.contract.read<ContextManifest>("context-manifest", {
        manifestId,
        turnId: digestId,
        requestIndex: 0,
        items: [
          {
            kind: "system_prompt",
            id: "digest.md",
            hash: promptHash,
            tokens: Math.ceil(prompt.length / 3),
            reason: "digest prompt",
          },
          {
            kind: "retrieval",
            id: `session:${sessionId}`,
            hash: createHash("sha256").update(messages[1]!.content).digest("hex"),
            tokens: Math.ceil(messages[1]!.content.length / 3),
            reason: "session records",
          },
        ],
        dropped: [],
        promptHash,
        createdAt: this.deps.clock.now(),
      });
    await this.queue.run(() =>
      this.available().transaction(() =>
        this.available().saveFeedback("manifest", manifestId, this.contract.read<Json>("json", manifest)),
      ),
    );
    const reservationId = this.deps.ids.next("reservation_");
    this.budgets.reserve(
      reservationId,
      [{ kind: "turn", key: digestId }, { kind: "session", key: sessionId }, { kind: "daily" }],
      estimateReservationMicros(request, model),
    );
    let output: DigestContent | undefined;
    for await (const event of this.gateway.call(request, {
      reservationId,
      idempotencyKey: digestId,
      signal: new AbortController().signal,
    })) {
      if (event.type === "output") output = this.contract.read<DigestContent>("digest-content", event.json);
      if (event.type === "error") fail("unavailable", event.message);
    }
    if (!output) fail("invalid", "Digest model returned no structured output");
    const previous = this.available()
        .feedbackList("digest")
        .map((value) => this.contract.read<SessionDigest>("session-digest", value))
        .filter((value) => value.sessionId === sessionId)
        .reduce((max, value) => Math.max(max, value.version), 0),
      digest = this.contract.read<SessionDigest>("session-digest", {
        digestId,
        sessionId,
        version: previous + 1,
        ...output,
        createdBy: "machine",
        createdAt: this.deps.clock.now(),
      });
    await this.queue.run(() =>
      this.available().transaction(() => {
        this.available().saveFeedback("digest", digestId, this.contract.read<Json>("json", digest));
        this.event("digest", digestId, "created");
      }),
    );
  }

  private resumeView(raw: Json): unknown {
    const p = this.contract.read<{ sessionId: string; since?: number }>(
      "operations/vc.ResumeView",
      raw,
      "#/properties/payload",
    );
    this.assertLifecycleVisible("session", p.sessionId);
    const store = this.available(),
      session = this.readSession(p.sessionId),
      seen = store.feedback("session-seen", p.sessionId),
      seenSeq = seen
        ? this.contract.read<SessionSeen>("session-seen", seen).lastSeenSeq
        : this.sessionStartSeq(p.sessionId),
      fromSeq = p.since ?? seenSeq,
      toSeq = store.lastSeq(),
      links = store
        .feedbackList("attachment")
        .map((value) => this.contract.read<{ sessionId: string; artifactId: string }>("session-artifact", value))
        .filter((link) => link.sessionId === p.sessionId && !this.isTrashed("artifact", link.artifactId)),
      artifactIds = new Set(links.map((link) => link.artifactId)),
      events = store.eventsAfter(fromSeq).filter((event) => event.seq <= toSeq),
      versionEvents = events.filter(
        (event) => event.type === "vc.VersionCommitted" && artifactIds.has(String(field(event.payload, "artifactId"))),
      ),
      commentsChanged = new Set<string>();
    for (const event of events) {
      const commentId = field(event.payload, "commentId"),
        sessionId = field(event.payload, "sessionId");
      if (typeof commentId === "string" && sessionId === p.sessionId) commentsChanged.add(commentId);
    }
    const comments = [...commentsChanged]
      .map((commentId) => store.feedback("comment", commentId))
      .filter((value): value is Json => value !== undefined)
      .map((value) => this.contract.read<FeedbackComment>("feedback-comment", value))
      .filter((comment) => !comment.deleted && !this.isTrashed("comment", comment.commentId));
    const awaitingAgreement = comments.filter(
        (comment) =>
          comment.author.kind === "agent" &&
          comment.proposal !== undefined &&
          ["open", "discussing"].includes(comment.state),
      ),
      conflicts = store
        .feedbackList("conflict")
        .map((value) =>
          this.contract.read<import("../../../contract/src/index.js").FeedbackConflict>("feedback-conflict", value),
        )
        .filter(
          (conflict) =>
            conflict.state === "open" &&
            typeof conflict.artifactId === "string" &&
            artifactIds.has(conflict.artifactId),
        ),
      updates = store
        .feedbackList("update")
        .map((value) => this.contract.read<Update>("update", value))
        .filter(
          (update) =>
            artifactIds.has(update.artifactId) &&
            [
              "queued",
              "planning",
              "awaiting_plan_review",
              "writing",
              "checking",
              "failed",
              "partially_committed",
            ].includes(update.status),
        ),
      outputSets = store
        .feedbackList("output-set")
        .map((value) => this.contract.read<OutputSet>("output-set", value))
        .filter(
          (set) => set.sessionId === p.sessionId || set.members.some((member) => artifactIds.has(member.artifactId)),
        ),
      lastOutputSet = outputSets.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
      changesSinceOutputSet = lastOutputSet
        ? lastOutputSet.members.flatMap((member) => {
            const headVersion = store.artifact(member.artifactId).headVersion;
            return headVersion > member.version
              ? [{ artifactId: member.artifactId, fromVersion: member.version, toVersion: headVersion }]
              : [];
          })
        : [];
    const versions = versionEvents.map((event) => {
      const payload = this.contract.read<{
          artifactId: string;
          version: number;
          writeSet: string[];
          source: Version["source"];
        }>("events/vc.VersionCommitted", event.payload),
        version = store.version(payload.artifactId, payload.version);
      return {
        artifactId: payload.artifactId,
        version: payload.version,
        createdAt: version.createdAt,
        changeCount: payload.writeSet.length,
        source: payload.source,
      };
    });
    const result = {
      sessionId: session.sessionId,
      fromSeq,
      toSeq,
      versions,
      comments: comments.filter((comment) => comment.author.kind !== "agent"),
      replies: comments.filter((comment) => comment.author.kind === "agent"),
      awaitingAgreement: awaitingAgreement.map((comment) => ({
        commentId: comment.commentId,
        threadId: comment.threadId,
        proposal: comment.proposal,
      })),
      conflicts,
      updates,
      ...(lastOutputSet ? { lastOutputSet } : {}),
      changesSinceOutputSet,
    };
    return result;
  }

  private purgePreview(target: TrashTarget) {
    const store = this.available(),
      commentIds = new Set<string>();
    for (const value of store.feedbackList("comment")) {
      const comment = this.contract.read<FeedbackComment>("feedback-comment", value);
      if (
        (target.kind === "comment" && comment.commentId === target.id) ||
        (target.kind === "session" && comment.sessionId === target.id) ||
        (target.kind === "artifact" && comment.anchor?.artifactId === target.id)
      )
        commentIds.add(comment.commentId);
    }
    const agreements = store
        .feedbackList("agreement")
        .map((value) => this.contract.read<Agreement>("agreement", value)),
      agreementIds = agreements.filter((agreement) => commentIds.has(agreement.commentId)).map((a) => a.agreementId),
      updateIds = store
        .feedbackList("update")
        .filter((value) => target.kind === "artifact" && field(value, "artifactId") === target.id)
        .map((value) => String(field(value, "updateId"))),
      conflictIds = store
        .feedbackList("conflict")
        .filter((value) => target.kind === "artifact" && field(value, "artifactId") === target.id)
        .map((value) => String(field(value, "conflictId"))),
      outputSetIds = store
        .feedbackList("output-set")
        .filter((value) => {
          const set = this.contract.read<OutputSet>("output-set", value);
          return (
            (target.kind === "session" && set.sessionId === target.id) ||
            (target.kind === "artifact" && set.members.some((member) => member.artifactId === target.id))
          );
        })
        .map((value) => String(field(value, "outputSetId"))),
      digestIds = store
        .feedbackList("digest")
        .filter((value) => target.kind === "session" && field(value, "sessionId") === target.id)
        .map((value) => String(field(value, "digestId"))),
      manifestIds = store
        .feedbackList("manifest")
        .map((value) => this.contract.read<ContextManifest>("context-manifest", value))
        .filter((manifest) =>
          target.kind === "session"
            ? store
                .feedbackList("agent-turn")
                .some((turn) => field(turn, "turnId") === manifest.turnId && field(turn, "sessionId") === target.id)
            : commentIds.has(manifest.turnId),
        )
        .map((manifest) => manifest.manifestId),
      revisionHashes =
        target.kind === "artifact"
          ? store.versions(target.id).flatMap((version) => Object.values(version.manifest))
          : [],
      blobHashes =
        target.kind === "artifact"
          ? store
              .versions(target.id)
              .flatMap((version) =>
                store
                  .elements(target.id, version.version)
                  .flatMap((element) => (element.type === "image" ? [element.blobHash] : [])),
              )
          : [];
    const uniqueBlobs = [...new Set(blobHashes)],
      recordIds = new Set<string>([
        `${target.kind}:${target.id}`,
        ...[...commentIds].map((id) => `comment:${id}`),
        ...agreementIds.map((id) => `agreement:${id}`),
        ...digestIds.map((id) => `digest:${id}`),
        ...manifestIds.map((id) => `manifest:${id}`),
        ...updateIds.map((id) => `update:${id}`),
        ...conflictIds.map((id) => `conflict:${id}`),
        ...outputSetIds.map((id) => `output-set:${id}`),
      ]);
    return {
      target,
      recordIds: [...recordIds],
      revisionHashes: [...new Set(revisionHashes)],
      blobHashes: uniqueBlobs,
      manifestIds,
      digestIds,
      commentIds: [...commentIds],
      agreementIds,
      updateIds,
      conflictIds,
      outputSetIds,
    };
  }

  private validateTrashTarget(target: TrashTarget): void {
    const store = this.available();
    if (target.kind === "artifact") store.artifact(target.id);
    else if (!store.feedback(target.kind === "comment" ? "comment" : target.kind, target.id))
      fail("not_found", `${target.kind} not found`);
  }

  private validateExportTarget(target: { artifactId: string; version?: number } | { outputSetId: string }): void {
    if ("artifactId" in target) {
      this.assertLifecycleVisible("artifact", target.artifactId);
      this.available().version(target.artifactId, target.version);
    } else this.feedbackRecord<OutputSet>("output-set", "output-set", target.outputSetId);
  }

  private exportMembers(target: { artifactId: string; version?: number } | { outputSetId: string }) {
    if ("artifactId" in target) {
      const version = this.available().version(target.artifactId, target.version);
      return [{ artifactId: target.artifactId, version: version.version }];
    }
    return this.feedbackRecord<OutputSet>("output-set", "output-set", target.outputSetId).members;
  }

  private exportSessionIds(target: { artifactId: string; version?: number } | { outputSetId: string }): string[] {
    if ("outputSetId" in target) {
      const sessionId = this.feedbackRecord<OutputSet>("output-set", "output-set", target.outputSetId).sessionId;
      return sessionId ? [sessionId] : [];
    }
    return this.available()
      .feedbackList("attachment")
      .map((value) => this.contract.read<{ sessionId: string; artifactId: string }>("session-artifact", value))
      .filter((link) => link.artifactId === target.artifactId)
      .map((link) => link.sessionId);
  }

  private exportThreads(sessionIds: string[], artifactIds: string[]): FeedbackComment[] {
    return this.available()
      .feedbackList("comment")
      .map((value) => this.contract.read<FeedbackComment>("feedback-comment", value))
      .filter(
        (comment) =>
          sessionIds.includes(comment.sessionId) &&
          !comment.deleted &&
          (!comment.anchor?.artifactId || artifactIds.includes(comment.anchor.artifactId)),
      );
  }

  private exportAgreements(artifactIds: string[]): Agreement[] {
    const comments = new Map(
      this.available()
        .feedbackList("comment")
        .map((value) => {
          const comment = this.contract.read<FeedbackComment>("feedback-comment", value);
          return [comment.commentId, comment] as const;
        }),
    );
    return this.available()
      .feedbackList("agreement")
      .map((value) => this.contract.read<Agreement>("agreement", value))
      .filter((agreement) => artifactIds.includes(comments.get(agreement.commentId)?.anchor?.artifactId ?? ""));
  }

  private readSession(sessionId: string): Session {
    this.assertLifecycleVisible("session", sessionId);
    return this.feedbackRecord<Session>("session", "session", sessionId);
  }

  private feedbackRecord<T>(kind: string, schema: string, id: string): T {
    const value = this.available().feedback(kind, id);
    if (value === undefined) fail("not_found", `${kind} not found`);
    return this.contract.read<T>(schema, value);
  }

  private event(kind: string, id: string, action: string, status?: string): void {
    this.available().appendEvent({
      ts: this.deps.clock.now(),
      type: "vc.LifecycleChanged",
      entity: { kind, id },
      payload: { kind, id, action, ...(status ? { status } : {}) },
    });
    this.wake();
  }

  private jobId(job: Job, key: string): string {
    if (typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload))
      fail("invalid", "Invalid lifecycle job");
    const value = field(job.payload, key);
    if (typeof value !== "string") fail("invalid", "Invalid lifecycle job");
    return value;
  }

  private trashKey(target: TrashTarget): string {
    return `${target.kind}:${target.id}`;
  }

  private isTrashed(kind: TrashTarget["kind"], id: string): boolean {
    return this.available().feedback("trash", this.trashKey({ kind, id })) !== undefined;
  }

  protected assertLifecycleVisible(kind: TrashTarget["kind"], id: string, includeTrashed = false): void {
    if (!includeTrashed && this.isTrashed(kind, id)) fail("not_found", "Item not found");
  }

  private filterTrashedQuery(name: string, raw: Json, result: unknown): unknown {
    const includeTrashed = field(raw, "includeTrashed") === true;
    if (includeTrashed || !Array.isArray(result)) return result;
    const stillVisible = (kind: TrashTarget["kind"], id: unknown) =>
      typeof id !== "string" || !this.isTrashed(kind, id);
    if (name === "vc.Ideas") return result.filter((value) => stillVisible("idea", field(value, "ideaId")));
    if (name === "vc.Projects") return result.filter((value) => stillVisible("project", field(value, "projectId")));
    if (name === "vc.Sessions") return result.filter((value) => stillVisible("session", field(value, "sessionId")));
    if (name === "vc.Conflicts")
      return result.filter(
        (value) =>
          stillVisible("session", field(value, "sessionId")) && stillVisible("artifact", field(value, "artifactId")),
      );
    if (name === "vc.DecisionRecord")
      return result.filter((value) => {
        const comment = this.available().feedback("comment", String(field(value, "commentId")));
        return (
          comment !== undefined &&
          stillVisible("comment", field(comment, "commentId")) &&
          stillVisible("session", field(comment, "sessionId")) &&
          stillVisible("artifact", field(field(comment, "anchor"), "artifactId"))
        );
      });
    if (name === "vc.FeedbackItems")
      return result.filter(
        (value) =>
          stillVisible("comment", field(value, "commentId")) &&
          stillVisible("session", field(value, "sessionId")) &&
          stillVisible("artifact", field(field(value, "anchor"), "artifactId")),
      );
    if (name === "vc.Threads")
      return result
        .filter((value) => stillVisible("session", field(value, "sessionId")))
        .map((value) => {
          const comments = field(value, "comments");
          if (!Array.isArray(comments)) return value;
          const visible = comments.filter(
            (comment) =>
              stillVisible("comment", field(comment, "commentId")) &&
              stillVisible("artifact", field(field(comment, "anchor"), "artifactId")),
          );
          return { ...(typeof value === "object" && value !== null ? value : {}), comments: visible };
        })
        .filter((value) => {
          const comments = field(value, "comments");
          return Array.isArray(comments) && comments.length > 0;
        });
    if (name === "vc.AttentionInbox")
      return result.filter(
        (value) =>
          stillVisible("session", field(value, "sessionId")) &&
          stillVisible("artifact", field(value, "artifactId")) &&
          (field(value, "kind") !== "proposal" || stillVisible("comment", field(value, "id"))),
      );
    return result;
  }

  private sessionStartSeq(sessionId: string): number {
    return (
      this.available()
        .eventsAfter(0)
        .find((event) => event.type === "vc.SessionStarted" && field(event.payload, "sessionId") === sessionId)?.seq ??
      0
    );
  }

  private recordId(kind: string, value: Json): string | undefined {
    const key: Record<string, string> = {
      session: "sessionId",
      "session-seen": "sessionId",
      "session-digest": "digestId",
      digest: "digestId",
      attachment: "sessionId",
      "agent-turn": "turnId",
      manifest: "manifestId",
      "delivery-state": "commentId",
      "reply-trigger": "sessionId",
    };
    const id = field(value, key[kind] ?? "id");
    return typeof id === "string" ? (kind === "attachment" ? `${id}:${field(value, "artifactId")}` : id) : undefined;
  }

  private blobPath(hash: string): string {
    return join(this.workspace, "blobs", hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  private internalContext(requestId: string): CallContext {
    return {
      contractVersion: CONTRACT_VERSION,
      principal: { kind: "system", job: "export" },
      channel: "in_process",
      scope: "admin",
      requestId,
    };
  }

  private async listFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) results.push(path);
      }
    };
    await visit(root);
    return results.sort();
  }

  private async loadImageSources(elements: Element[]): Promise<Map<string, string>> {
    const sources = new Map<string, string>();
    for (const element of elements) {
      if (element.type !== "image" || sources.has(element.blobHash)) continue;
      const bytes = await readFile(this.blobPath(element.blobHash));
      let mediaType: string | undefined;
      try {
        const metadata = JSON.parse(await readFile(`${this.blobPath(element.blobHash)}.meta.json`, "utf8")) as unknown;
        const candidate = field(metadata, "mediaType");
        if (typeof candidate === "string") mediaType = candidate.toLowerCase();
      } catch {
        mediaType = undefined;
      }
      mediaType ??= sniffImageType(bytes);
      if (!mediaType || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType))
        fail("invalid", "HTML export cannot embed an image with an unsupported media type");
      sources.set(element.blobHash, `data:${mediaType};base64,${bytes.toString("base64")}`);
    }
    return sources;
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function sniffImageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  return undefined;
}
