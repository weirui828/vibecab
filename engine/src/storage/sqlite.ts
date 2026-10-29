import Database from 'better-sqlite3';
import { Contract, fail } from '../../../contract/src/index.js';
import type { CommandResult, Element, EventEnvelope, Job, Json, Version } from '../../../contract/src/index.js';
import type { Artifact, Repository } from './repository.js';
import { canonical, revisionHash } from '../content/hash.js';
function field(row: unknown, key: string): unknown { return typeof row === 'object' && row !== null ? Reflect.get(row, key) : undefined; }
function json(row: unknown): unknown { const value = field(row, 'json'); if (typeof value !== 'string')
    throw Error('Corrupt storage'); return JSON.parse(value); }
export class SqliteStore implements Repository {
    private readonly db: Database.Database;
    constructor(path: string, private readonly contract: Contract) {
        this.db = new Database(path);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('busy_timeout = 5000');
        this.db.exec(`
   CREATE TABLE IF NOT EXISTS sys_commands(command_id TEXT PRIMARY KEY,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sys_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sys_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,lease_until TEXT,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS vc_artifacts(artifact_id TEXT PRIMARY KEY,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS vc_element_revisions(hash TEXT PRIMARY KEY,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS vc_versions(artifact_id TEXT NOT NULL,version INTEGER NOT NULL,parent_version INTEGER,created_by TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(artifact_id,version),FOREIGN KEY(artifact_id) REFERENCES vc_artifacts(artifact_id));
   CREATE TABLE IF NOT EXISTS vc_version_entries(artifact_id TEXT NOT NULL,version INTEGER NOT NULL,element_id TEXT NOT NULL,revision_hash TEXT NOT NULL,PRIMARY KEY(artifact_id,version,element_id),FOREIGN KEY(artifact_id,version) REFERENCES vc_versions(artifact_id,version),FOREIGN KEY(revision_hash) REFERENCES vc_element_revisions(hash));
   CREATE INDEX IF NOT EXISTS vc_element_history ON vc_version_entries(element_id);
   CREATE INDEX IF NOT EXISTS sys_outbox_state ON sys_outbox(state,lease_until);
  `);
    }
    transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
    private writing() { if (!this.db.inTransaction)
        throw Error('Write outside command transaction'); }
    artifact(id: string): Artifact {
        const row = this.db.prepare('SELECT json FROM vc_artifacts WHERE artifact_id=?').get(id);
        if (!row)
            fail('not_found', 'Artifact not found');
        return this.contract.read<Artifact>('operations/vc.Artifact', json(row), '#/properties/result');
    }
    createArtifact(artifact: Artifact) { this.writing(); this.contract.read('operations/vc.Artifact', artifact, '#/properties/result'); this.db.prepare('INSERT INTO vc_artifacts VALUES(?,?)').run(artifact.artifactId, canonical(artifact)); }
    version(id: string, number = this.artifact(id).headVersion): Version {
        const row = this.db.prepare('SELECT json FROM vc_versions WHERE artifact_id=? AND version=?').get(id, number);
        if (!row)
            fail('not_found', 'Version not found');
        const version = this.contract.read<Version>('version', json(row));
        const manifest: Record<string, string> = {};
        for (const entry of this.db.prepare('SELECT element_id,revision_hash FROM vc_version_entries WHERE artifact_id=? AND version=?').all(id, number)) {
            const elementId = field(entry, 'element_id'), hash = field(entry, 'revision_hash');
            if (typeof elementId !== 'string' || typeof hash !== 'string')
                throw Error('Corrupt manifest');
            manifest[elementId] = hash;
        }
        if (canonical(version.manifest) !== canonical(manifest))
            throw Error('Corrupt manifest');
        return version;
    }
    versions(id: string): Version[] { this.artifact(id); return this.db.prepare('SELECT json FROM vc_versions WHERE artifact_id=? ORDER BY version').all(id).map(row => this.contract.read<Version>('version', json(row))); }
    elements(id: string, number = this.artifact(id).headVersion): Element[] {
        const version = this.version(id, number), elements: Element[] = [];
        for (const [elementId, hash] of Object.entries(version.manifest)) {
            const row = this.db.prepare('SELECT json FROM vc_element_revisions WHERE hash=?').get(hash);
            const e = this.contract.read<Element>('element', json(row));
            if (e.elementId !== elementId || revisionHash(e) !== hash)
                throw Error('Corrupt revision');
            elements.push(e);
        }
        this.contract.read('doc-tree', elements);
        return elements.sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.elementId.localeCompare(b.elementId));
    }
    elementIdExists(id: string): boolean { return this.db.prepare('SELECT 1 FROM vc_version_entries WHERE element_id=? LIMIT 1').get(id) !== undefined; }
    saveVersion(version: Version, elements: Element[]) {
        this.writing();
        this.contract.read('version', version);
        this.contract.read('doc-tree', elements);
        const artifact = this.artifact(version.artifactId);
        for (const element of elements) {
            const hash = revisionHash(element);
            if (version.manifest[element.elementId] !== hash)
                throw Error('Manifest mismatch');
            this.db.prepare('INSERT OR IGNORE INTO vc_element_revisions VALUES(?,?)').run(hash, canonical(element));
        }
        this.db.prepare('INSERT INTO vc_versions VALUES(?,?,?,?,?,?,?)').run(version.artifactId, version.version, version.parentVersion, canonical(version.createdBy), canonical(version.source), version.createdAt, canonical(version));
        // Full manifests intentionally keep historical versions independent of later commits.
        for (const [id, hash] of Object.entries(version.manifest))
            this.db.prepare('INSERT INTO vc_version_entries VALUES(?,?,?,?)').run(version.artifactId, version.version, id, hash);
        this.db.prepare('UPDATE vc_artifacts SET json=? WHERE artifact_id=?').run(canonical({ ...artifact, headVersion: version.version }), version.artifactId);
    }
    appendEvent(event: Omit<EventEnvelope, 'seq'>): EventEnvelope {
        this.writing();
        this.contract.read('events/' + event.type, event.payload);
        const next = this.lastSeq() + 1, validated = this.contract.read<EventEnvelope>('event-envelope', { ...event, seq: next });
        this.db.prepare('INSERT INTO sys_events(seq,json) VALUES(?,?)').run(next, canonical(validated));
        return validated;
    }
    eventsAfter(seq: number): EventEnvelope[] { return this.db.prepare('SELECT json FROM sys_events WHERE seq>? ORDER BY seq').all(seq).map(row => {const event=this.contract.read<EventEnvelope>('event-envelope',json(row));this.contract.read('events/'+event.type,event.payload);return event;}); }
    lastSeq(): number { const seq = field(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM sys_events').get(), 'seq'); if (typeof seq !== 'number')
        throw Error('Invalid cursor'); return seq; }
    command(id: string): CommandResult | undefined { const row = this.db.prepare('SELECT json FROM sys_commands WHERE command_id=?').get(id); return row ? this.contract.read<CommandResult>('command-result', json(row)) : undefined; }
    saveCommand(id: string, result: CommandResult) { this.writing(); this.contract.read('command-result', result); this.db.prepare('INSERT INTO sys_commands VALUES(?,?)').run(id, canonical(result)); }
    enqueue(kind: string, id: string, payload: Json, ts: string) { this.writing(); const job: Job = { id, kind, payload, state: 'pending', leaseUntil: null, attempts: 0, createdAt: ts }; this.contract.read('job', job); this.db.prepare('INSERT INTO sys_outbox VALUES(?,?,?,?,?)').run(id, kind, job.state, null, canonical(job)); }
    jobs(): Job[] { return this.db.prepare('SELECT json FROM sys_outbox ORDER BY rowid').all().map(row => this.contract.read<Job>('job', json(row))); }
    lease(id: string, until: string) { this.writing(); const job = this.jobs().find(j => j.id === id); if (!job || job.state !== 'pending')
        fail('conflict', 'Job is not pending'); this.writeJob({ ...job, state: 'leased', leaseUntil: until, attempts: job.attempts + 1 }); }
    jobState(id: string, state: Job['state']) { this.writing(); const job = this.jobs().find(j => j.id === id); if (!job)
        fail('not_found', 'Job not found'); this.writeJob({ ...job, state, leaseUntil: null }); }
    private writeJob(job: Job) { this.contract.read('job', job); this.db.prepare('UPDATE sys_outbox SET state=?,lease_until=?,json=? WHERE id=?').run(job.state, job.leaseUntil, canonical(job), job.id); }
    close() { this.db.close(); }
}
