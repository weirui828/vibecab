import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CONTRACT_VERSION, fail } from "../../../contract/src/index.js";
import type {
  Agreement,
  CallContext,
  ContextManifest,
  Element,
  FeedbackComment,
  Job,
  Json,
  OutputSet,
  Session,
  SessionSeen,
  TrashRecord,
  Update,
  Version,
} from "../../../contract/src/index.js";

import { UpdateRuntime } from "../updates/runtime.js";
type TrashTarget = TrashRecord["kind"] extends never ? never : { kind: TrashRecord["kind"]; id: string };
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export abstract class LifecycleHelpersRuntime extends UpdateRuntime {
  protected resumeView(raw: Json): unknown {
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

  protected purgePreview(target: TrashTarget) {
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

  protected validateTrashTarget(target: TrashTarget): void {
    const store = this.available();
    if (target.kind === "artifact") store.artifact(target.id);
    else if (!store.feedback(target.kind === "comment" ? "comment" : target.kind, target.id))
      fail("not_found", `${target.kind} not found`);
  }

  protected validateExportTarget(target: { artifactId: string; version?: number } | { outputSetId: string }): void {
    if ("artifactId" in target) {
      this.assertLifecycleVisible("artifact", target.artifactId);
      this.available().version(target.artifactId, target.version);
    } else this.feedbackRecord<OutputSet>("output-set", "output-set", target.outputSetId);
  }

  protected exportMembers(target: { artifactId: string; version?: number } | { outputSetId: string }) {
    if ("artifactId" in target) {
      const version = this.available().version(target.artifactId, target.version);
      return [{ artifactId: target.artifactId, version: version.version }];
    }
    return this.feedbackRecord<OutputSet>("output-set", "output-set", target.outputSetId).members;
  }

  protected exportSessionIds(target: { artifactId: string; version?: number } | { outputSetId: string }): string[] {
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

  protected exportThreads(sessionIds: string[], artifactIds: string[]): FeedbackComment[] {
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

  protected exportAgreements(artifactIds: string[]): Agreement[] {
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

  protected readSession(sessionId: string): Session {
    this.assertLifecycleVisible("session", sessionId);
    return this.feedbackRecord<Session>("session", "session", sessionId);
  }

  protected feedbackRecord<T>(kind: string, schema: string, id: string): T {
    const value = this.available().feedback(kind, id);
    if (value === undefined) fail("not_found", `${kind} not found`);
    return this.contract.read<T>(schema, value);
  }

  protected event(kind: string, id: string, action: string, status?: string): void {
    this.available().appendEvent({
      ts: this.deps.clock.now(),
      type: "vc.LifecycleChanged",
      entity: { kind, id },
      payload: { kind, id, action, ...(status ? { status } : {}) },
    });
    this.wake();
  }

  protected jobId(job: Job, key: string): string {
    if (typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload))
      fail("invalid", "Invalid lifecycle job");
    const value = field(job.payload, key);
    if (typeof value !== "string") fail("invalid", "Invalid lifecycle job");
    return value;
  }

  protected trashKey(target: TrashTarget): string {
    return `${target.kind}:${target.id}`;
  }

  protected isTrashed(kind: TrashTarget["kind"], id: string): boolean {
    return this.available().feedback("trash", this.trashKey({ kind, id })) !== undefined;
  }

  protected assertLifecycleVisible(kind: TrashTarget["kind"], id: string, includeTrashed = false): void {
    if (!includeTrashed && this.isTrashed(kind, id)) fail("not_found", "Item not found");
  }

  protected filterTrashedQuery(name: string, raw: Json, result: unknown): unknown {
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

  protected sessionStartSeq(sessionId: string): number {
    return (
      this.available()
        .eventsAfter(0)
        .find((event) => event.type === "vc.SessionStarted" && field(event.payload, "sessionId") === sessionId)?.seq ??
      0
    );
  }

  protected recordId(kind: string, value: Json): string | undefined {
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

  protected blobPath(hash: string): string {
    return join(this.workspace, "blobs", hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  protected internalContext(requestId: string): CallContext {
    return {
      contractVersion: CONTRACT_VERSION,
      principal: { kind: "system", job: "export" },
      channel: "in_process",
      scope: "admin",
      requestId,
    };
  }

  protected async listFiles(root: string): Promise<string[]> {
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

  protected async loadImageSources(elements: Element[]): Promise<Map<string, string>> {
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

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function sniffImageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  return undefined;
}
