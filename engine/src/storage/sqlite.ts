import Database from "better-sqlite3";
import { Contract, fail } from "../../../contract/src/index.js";
import type {
  CallLog,
  CommandResult,
  Element,
  EventEnvelope,
  Job,
  Json,
  Version,
} from "../../../contract/src/index.js";
import type { Artifact, Repository, SearchHit, StoredAccessToken } from "./repository.js";
import { canonical, revisionHash } from "../content/hash.js";
import { appendFeedbackStateEvents } from "./app-events.js";
function field(row: unknown, key: string): unknown {
  return typeof row === "object" && row !== null ? Reflect.get(row, key) : undefined;
}
function json(row: unknown): unknown {
  const value = field(row, "json");
  if (typeof value !== "string") throw Error("Corrupt storage");
  return JSON.parse(value);
}
export class SqliteStore implements Repository {
  private readonly db: Database.Database;
  constructor(
    path: string,
    private readonly contract: Contract,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
   CREATE TABLE IF NOT EXISTS sys_commands(command_id TEXT PRIMARY KEY,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sys_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sys_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,lease_until TEXT,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS vc_artifacts(artifact_id TEXT PRIMARY KEY,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS vc_feedback(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
   CREATE INDEX IF NOT EXISTS vc_feedback_kind ON vc_feedback(kind,id);
   CREATE TABLE IF NOT EXISTS sys_call_log(call_id TEXT PRIMARY KEY,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sys_access_tokens(
     token_id TEXT PRIMARY KEY,name TEXT NOT NULL,channel TEXT NOT NULL,scope TEXT NOT NULL,
     secret_hash TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT
   );
   CREATE TABLE IF NOT EXISTS sys_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE VIRTUAL TABLE IF NOT EXISTS vc_search USING fts5(
     kind UNINDEXED, session_id UNINDEXED, artifact_id UNINDEXED, record_id UNINDEXED, text
   );
   CREATE TABLE IF NOT EXISTS vc_element_revisions(hash TEXT PRIMARY KEY,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS vc_versions(
     artifact_id TEXT NOT NULL, version INTEGER NOT NULL, parent_version INTEGER,
     created_by TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL,
     PRIMARY KEY(artifact_id,version), FOREIGN KEY(artifact_id) REFERENCES vc_artifacts(artifact_id)
   );
   CREATE TABLE IF NOT EXISTS vc_version_entries(
     artifact_id TEXT NOT NULL, version INTEGER NOT NULL, element_id TEXT NOT NULL, revision_hash TEXT NOT NULL,
     PRIMARY KEY(artifact_id,version,element_id),
     FOREIGN KEY(artifact_id,version) REFERENCES vc_versions(artifact_id,version),
     FOREIGN KEY(revision_hash) REFERENCES vc_element_revisions(hash)
   );
   CREATE INDEX IF NOT EXISTS vc_element_history ON vc_version_entries(element_id);
   CREATE INDEX IF NOT EXISTS sys_outbox_state ON sys_outbox(state,lease_until);
  `);
  }
  transaction<T>(action: () => T): T {
    return this.db.transaction(action)();
  }
  async backup(path: string): Promise<void> {
    await this.db.backup(path);
  }
  compact(): void {
    if (this.db.inTransaction) throw Error("Cannot compact storage during a transaction");
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.exec("VACUUM");
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }
  private writing() {
    if (!this.db.inTransaction) throw Error("Write outside command transaction");
  }
  artifact(id: string): Artifact {
    const row = this.db.prepare("SELECT json FROM vc_artifacts WHERE artifact_id=?").get(id);
    if (!row) fail("not_found", "Artifact not found");
    return this.contract.read<Artifact>("operations/vc.Artifact", json(row), "#/properties/result");
  }
  createArtifact(artifact: Artifact) {
    this.writing();
    this.contract.read("operations/vc.Artifact", artifact, "#/properties/result");
    this.db.prepare("INSERT INTO vc_artifacts VALUES(?,?)").run(artifact.artifactId, canonical(artifact));
  }
  renameArtifact(id: string, title: string, updatedAt: string): Artifact {
    this.writing();
    const artifact = this.artifact(id),
      updated = this.contract.read<Artifact>(
        "operations/vc.Artifact",
        {
          ...artifact,
          title,
          updatedAt,
        },
        "#/properties/result",
      );
    this.db.prepare("UPDATE vc_artifacts SET json=? WHERE artifact_id=?").run(canonical(updated), id);
    return updated;
  }
  version(id: string, number = this.artifact(id).headVersion): Version {
    const row = this.db.prepare("SELECT json FROM vc_versions WHERE artifact_id=? AND version=?").get(id, number);
    if (!row) fail("not_found", "Version not found");
    const version = this.contract.read<Version>("version", json(row));
    const manifest: Record<string, string> = {};
    for (const entry of this.db
      .prepare("SELECT element_id,revision_hash FROM vc_version_entries WHERE artifact_id=? AND version=?")
      .all(id, number)) {
      const elementId = field(entry, "element_id"),
        hash = field(entry, "revision_hash");
      if (typeof elementId !== "string" || typeof hash !== "string") throw Error("Corrupt manifest");
      manifest[elementId] = hash;
    }
    if (canonical(version.manifest) !== canonical(manifest)) throw Error("Corrupt manifest");
    return version;
  }
  versions(id: string): Version[] {
    this.artifact(id);
    return this.db
      .prepare("SELECT json FROM vc_versions WHERE artifact_id=? ORDER BY version")
      .all(id)
      .map((row) => this.contract.read<Version>("version", json(row)));
  }
  elements(id: string, number = this.artifact(id).headVersion): Element[] {
    const version = this.version(id, number),
      elements: Element[] = [];
    for (const [elementId, hash] of Object.entries(version.manifest)) {
      const row = this.db.prepare("SELECT json FROM vc_element_revisions WHERE hash=?").get(hash);
      const e = this.contract.read<Element>("element", json(row));
      if (e.elementId !== elementId || revisionHash(e) !== hash) throw Error("Corrupt revision");
      elements.push(e);
    }
    this.contract.read("doc-tree", elements);
    return elements.sort((a, b) =>
      a.order < b.order ? -1 : a.order > b.order ? 1 : a.elementId.localeCompare(b.elementId),
    );
  }
  elementIdExists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM vc_version_entries WHERE element_id=? LIMIT 1").get(id) !== undefined;
  }
  saveVersion(version: Version, elements: Element[]) {
    this.writing();
    this.contract.read("version", version);
    this.contract.read("doc-tree", elements);
    const artifact = this.artifact(version.artifactId);
    for (const element of elements) {
      const hash = revisionHash(element);
      if (version.manifest[element.elementId] !== hash) throw Error("Manifest mismatch");
      this.db.prepare("INSERT OR IGNORE INTO vc_element_revisions VALUES(?,?)").run(hash, canonical(element));
    }
    this.db
      .prepare("INSERT INTO vc_versions VALUES(?,?,?,?,?,?,?)")
      .run(
        version.artifactId,
        version.version,
        version.parentVersion,
        canonical(version.createdBy),
        canonical(version.source),
        version.createdAt,
        canonical(version),
      );
    // Full manifests intentionally keep historical versions independent of later commits.
    for (const [id, hash] of Object.entries(version.manifest))
      this.db
        .prepare("INSERT INTO vc_version_entries VALUES(?,?,?,?)")
        .run(version.artifactId, version.version, id, hash);
    this.db
      .prepare("UPDATE vc_artifacts SET json=? WHERE artifact_id=?")
      .run(canonical({ ...artifact, headVersion: version.version, updatedAt: version.createdAt }), version.artifactId);
    this.db.prepare("DELETE FROM vc_search WHERE kind='element' AND artifact_id=?").run(version.artifactId);
    const sessions = this.db
      .prepare("SELECT json FROM vc_feedback WHERE kind='attachment'")
      .all()
      .map((row) => this.contract.read<{ sessionId: string; artifactId: string }>("session-artifact", json(row)))
      .filter((link) => link.artifactId === version.artifactId)
      .map((link) => link.sessionId);
    for (const sessionId of sessions)
      for (const element of elements)
        if ("text" in element && element.text.length)
          this.db
            .prepare("INSERT INTO vc_search(kind,session_id,artifact_id,record_id,text) VALUES(?,?,?,?,?)")
            .run("element", sessionId, version.artifactId, element.elementId, element.text);
  }
  appendEvent(event: Omit<EventEnvelope, "seq">): EventEnvelope {
    this.writing();
    this.contract.read("events/" + event.type, event.payload);
    const next = this.lastSeq() + 1,
      validated = this.contract.read<EventEnvelope>("event-envelope", {
        ...event,
        seq: next,
      });
    this.db.prepare("INSERT INTO sys_events(seq,json) VALUES(?,?)").run(next, canonical(validated));
    return validated;
  }
  eventsAfter(seq: number): EventEnvelope[] {
    return this.db
      .prepare("SELECT json FROM sys_events WHERE seq>? ORDER BY seq")
      .all(seq)
      .map((row) => {
        const event = this.contract.read<EventEnvelope>("event-envelope", json(row));
        this.contract.read("events/" + event.type, event.payload);
        return event;
      });
  }
  lastSeq(): number {
    const seq = field(this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM sys_events").get(), "seq");
    if (typeof seq !== "number") throw Error("Invalid cursor");
    return seq;
  }
  command(id: string): CommandResult | undefined {
    const row = this.db.prepare("SELECT json FROM sys_commands WHERE command_id=?").get(id);
    return row ? this.contract.read<CommandResult>("command-result", json(row)) : undefined;
  }
  saveCommand(id: string, result: CommandResult) {
    this.writing();
    this.contract.read("command-result", result);
    this.db.prepare("INSERT INTO sys_commands VALUES(?,?)").run(id, canonical(result));
  }
  enqueue(kind: string, id: string, payload: Json, ts: string) {
    this.writing();
    const job: Job = {
      id,
      kind,
      payload,
      state: "pending",
      leaseUntil: null,
      attempts: 0,
      createdAt: ts,
    };
    this.contract.read("job", job);
    this.db.prepare("INSERT INTO sys_outbox VALUES(?,?,?,?,?)").run(id, kind, job.state, null, canonical(job));
  }
  rescheduleJob(id: string, payload: Json, ts: string) {
    this.writing();
    const job = this.jobs().find((candidate) => candidate.id === id);
    if (!job) fail("not_found", "Job not found");
    this.writeJob(
      this.contract.read<Job>("job", {
        ...job,
        payload,
        state: "pending",
        leaseUntil: null,
        attempts: 0,
        createdAt: ts,
      }),
    );
  }
  deleteJob(id: string) {
    this.writing();
    this.db.prepare("DELETE FROM sys_outbox WHERE id=?").run(id);
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT json FROM sys_outbox ORDER BY rowid")
      .all()
      .map((row) => this.contract.read<Job>("job", json(row)));
  }
  pruneCompletedJobs(kind: string): number {
    this.writing();
    return this.db.prepare("DELETE FROM sys_outbox WHERE kind=? AND state='completed'").run(kind).changes;
  }
  lease(id: string, until: string) {
    this.writing();
    const job = this.jobs().find((j) => j.id === id);
    if (!job || job.state !== "pending") fail("conflict", "Job is not pending");
    this.writeJob({
      ...job,
      state: "leased",
      leaseUntil: until,
      attempts: job.attempts + 1,
    });
  }
  jobState(id: string, state: Job["state"]) {
    this.writing();
    const job = this.jobs().find((j) => j.id === id);
    if (!job) fail("not_found", "Job not found");
    this.writeJob({ ...job, state, leaseUntil: null });
  }
  feedback(kind: string, id: string): Json | undefined {
    const row = this.db.prepare("SELECT json FROM vc_feedback WHERE kind=? AND id=?").get(kind, id);
    return row ? this.contract.read<Json>("json", json(row)) : undefined;
  }
  feedbackList(kind: string): Json[] {
    return this.db
      .prepare("SELECT json FROM vc_feedback WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((row) => this.contract.read<Json>("json", json(row)));
  }
  saveFeedback(kind: string, id: string, value: Json) {
    this.writing();
    this.contract.read<Json>("json", value);
    const previous = this.db.prepare("SELECT json FROM vc_feedback WHERE kind=? AND id=?").get(kind, id),
      before = previous ? this.contract.read<Json>("json", json(previous)) : undefined;
    this.db
      .prepare(
        "INSERT INTO vc_feedback(kind,id,json) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json",
      )
      .run(kind, id, canonical(value));
    appendFeedbackStateEvents(this, this.contract, kind, id, before, value);
    if (kind === "comment") {
      this.db.prepare("DELETE FROM vc_search WHERE kind='comment' AND record_id=?").run(id);
      const comment = this.contract.read<{
        sessionId: string;
        body: string;
        deleted: boolean;
      }>("feedback-comment", value);
      if (!comment.deleted && comment.body.length)
        this.db
          .prepare("INSERT INTO vc_search(kind,session_id,artifact_id,record_id,text) VALUES(?,?,?,?,?)")
          .run("comment", comment.sessionId, "", id, comment.body);
    }
    if (kind === "attachment") {
      const link = this.contract.read<{
        sessionId: string;
        artifactId: string;
      }>("session-artifact", value);
      const elements = this.elements(link.artifactId);
      for (const element of elements)
        if ("text" in element && element.text.length) {
          this.db
            .prepare("DELETE FROM vc_search WHERE kind='element' AND session_id=? AND record_id=?")
            .run(link.sessionId, element.elementId);
          this.db
            .prepare("INSERT INTO vc_search(kind,session_id,artifact_id,record_id,text) VALUES(?,?,?,?,?)")
            .run("element", link.sessionId, link.artifactId, element.elementId, element.text);
        }
    }
  }
  deleteFeedback(kind: string, id: string) {
    this.writing();
    this.db.prepare("DELETE FROM vc_feedback WHERE kind=? AND id=?").run(kind, id);
    if (kind === "comment") this.db.prepare("DELETE FROM vc_search WHERE kind='comment' AND record_id=?").run(id);
  }
  deleteArtifact(id: string) {
    this.writing();
    this.artifact(id);
    this.db.prepare("DELETE FROM vc_search WHERE kind='element' AND artifact_id=?").run(id);
    this.db.prepare("DELETE FROM vc_version_entries WHERE artifact_id=?").run(id);
    this.db.prepare("DELETE FROM vc_versions WHERE artifact_id=?").run(id);
    this.db.prepare("DELETE FROM vc_artifacts WHERE artifact_id=?").run(id);
    this.pruneElementRevisions();
  }
  pruneElementRevisions(): string[] {
    this.writing();
    const hashes = this.db
      .prepare("SELECT hash FROM vc_element_revisions WHERE hash NOT IN (SELECT revision_hash FROM vc_version_entries)")
      .all();
    const removed = hashes.map((row) => field(row, "hash")).filter((hash): hash is string => typeof hash === "string");
    this.db
      .prepare("DELETE FROM vc_element_revisions WHERE hash NOT IN (SELECT revision_hash FROM vc_version_entries)")
      .run();
    return removed;
  }
  artifactIds(): string[] {
    return this.db
      .prepare("SELECT artifact_id FROM vc_artifacts ORDER BY artifact_id")
      .all()
      .map((row) => field(row, "artifact_id"))
      .filter((id): id is string => typeof id === "string");
  }
  callLogs(): CallLog[] {
    return this.db
      .prepare("SELECT json FROM sys_call_log ORDER BY rowid")
      .all()
      .map((row) => this.contract.read<CallLog>("call-log", json(row)));
  }
  saveCallLog(log: CallLog) {
    this.writing();
    this.contract.read<CallLog>("call-log", log);
    this.db
      .prepare(
        "INSERT INTO sys_call_log(call_id,json) VALUES(?,?) ON CONFLICT(call_id) DO UPDATE SET json=excluded.json",
      )
      .run(log.callId, canonical(log));
  }
  search(sessionId: string, query: string): SearchHit[] {
    const terms = query.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
    if (!terms.length) return [];
    const expression = terms.map((term) => '"' + term.replaceAll('"', '""') + '"').join(" OR ");
    return this.db
      .prepare(
        "SELECT kind,artifact_id,record_id,text FROM vc_search WHERE session_id=? AND vc_search MATCH ? ORDER BY rank LIMIT 20",
      )
      .all(sessionId, expression)
      .map((row) => {
        const kind = field(row, "kind"),
          artifactId = field(row, "artifact_id"),
          id = field(row, "record_id"),
          text = field(row, "text");
        if ((kind !== "comment" && kind !== "element") || typeof id !== "string" || typeof text !== "string")
          throw Error("Corrupt search index");
        return {
          kind,
          id,
          ...(typeof artifactId === "string" && artifactId.length ? { artifactId } : {}),
          text,
        };
      });
  }
  accessTokens(): StoredAccessToken[] {
    return this.db
      .prepare(
        "SELECT token_id,name,channel,scope,secret_hash,created_at,revoked_at FROM sys_access_tokens ORDER BY created_at,token_id",
      )
      .all()
      .map((row) => {
        const tokenId = field(row, "token_id"),
          name = field(row, "name"),
          channel = field(row, "channel"),
          scope = field(row, "scope"),
          secretHash = field(row, "secret_hash"),
          createdAt = field(row, "created_at"),
          revokedAt = field(row, "revoked_at");
        if (
          typeof tokenId !== "string" ||
          typeof name !== "string" ||
          (channel !== "http" && channel !== "cli" && channel !== "mcp") ||
          (scope !== "read" && scope !== "collaborate" && scope !== "admin") ||
          typeof secretHash !== "string" ||
          typeof createdAt !== "string" ||
          (revokedAt !== null && typeof revokedAt !== "string")
        )
          throw Error("Corrupt access token record");
        return { tokenId, name, channel, scope, secretHash, createdAt, ...(revokedAt ? { revokedAt } : {}) };
      });
  }
  createAccessToken(token: StoredAccessToken): void {
    this.writing();
    this.db
      .prepare("INSERT INTO sys_access_tokens VALUES(?,?,?,?,?,?,?)")
      .run(
        token.tokenId,
        token.name,
        token.channel,
        token.scope,
        token.secretHash,
        token.createdAt,
        token.revokedAt ?? null,
      );
  }
  revokeAccessToken(tokenId: string, revokedAt: string): void {
    this.writing();
    const result = this.db
      .prepare("UPDATE sys_access_tokens SET revoked_at=? WHERE token_id=? AND revoked_at IS NULL")
      .run(revokedAt, tokenId);
    if (result.changes === 0 && !this.accessTokens().some((token) => token.tokenId === tokenId))
      fail("not_found", "Access token not found");
  }
  accessTokenKey(factory: () => string): string {
    const existing = this.db.prepare("SELECT value FROM sys_meta WHERE key='access_token_hmac_key'").get();
    const value = field(existing, "value");
    if (typeof value === "string") return value;
    const key = factory();
    this.db.prepare("INSERT INTO sys_meta(key,value) VALUES('access_token_hmac_key',?)").run(key);
    return key;
  }
  private writeJob(job: Job) {
    this.contract.read("job", job);
    this.db
      .prepare("UPDATE sys_outbox SET state=?,lease_until=?,json=? WHERE id=?")
      .run(job.state, job.leaseUntil, canonical(job), job.id);
  }
  close() {
    this.db.close();
  }
}
