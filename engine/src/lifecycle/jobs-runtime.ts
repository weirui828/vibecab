import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonical } from "../content/hash.js";
import { estimateInputTokens, estimateReservationMicros } from "../gateway/ledger.js";
import type { ModelRequest } from "../gateway/types.js";
import { fail } from "../../../contract/src/index.js";
import type {
  Agreement,
  ContextManifest,
  DigestContent,
  Element,
  ExportRecord,
  FeedbackComment,
  Job,
  Json,
  SessionDigest,
  TrashRecord,
} from "../../../contract/src/index.js";
import { LifecycleHelpersRuntime } from "./helpers-runtime.js";
import { escapeHtml } from "./helpers-runtime.js";
import { renderHtmlDocument, renderHtmlFragment, renderMarkdown } from "./render.js";

const runFile = promisify(execFile);
type TrashTarget = { kind: TrashRecord["kind"]; id: string };
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export abstract class LifecycleJobsRuntime extends LifecycleHelpersRuntime {
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
    this.available().compact();
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
}
