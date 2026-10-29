import { open, mkdir, readFile, unlink, realpath, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Contract, CONTRACT_VERSION, errorOf, fail } from '../../contract/src/index.js';
import type { CallContext, CommandEnvelope, CommandResult, EventEnvelope, Json, QueryEnvelope, Subscription, VcCreateArtifactOperation, VcImportContentOperation, VcRestoreVersionOperation, VcArtifactOperation, VcOutlineOperation, VcElementsOperation, VcDiffOperation, VcResolveAnchorsOperation } from '../../contract/src/index.js';
import { unsupportedGroups } from '../../contract/src/catalog.js';
import { SqliteStore } from './storage/sqlite.js';
import { Content } from './content/content.js';
import { outline, diffVersions, resolveAnchors } from './content/diff.js';
import { defaults } from './kernel/dependencies.js';
import type { Dependencies } from './kernel/dependencies.js';
import { SerialQueue } from './kernel/queue.js';
import { JobRunner } from './kernel/jobs.js';
export interface Engine {
    start(workspaceDir: string): Promise<void>;
    drain(graceMs: number): Promise<void>;
    stop(): Promise<void>;
    command(ctx: CallContext, cmd: CommandEnvelope): Promise<CommandResult>;
    query(ctx: CallContext, q: QueryEnvelope): Promise<Json>;
    subscribe(ctx: CallContext, sub: Subscription): AsyncIterable<EventEnvelope>;
    putBlob(ctx: CallContext, bytes: Uint8Array, mediaType: string): Promise<string>;
    getBlob(ctx: CallContext, hash: string): Promise<Uint8Array>;
}
export function createEngine(options: Partial<Dependencies> = {}): Engine { return new LocalEngine({ ...defaults(), ...options }); }
class LocalEngine implements Engine {
    private readonly contract = new Contract();
    private readonly queue = new SerialQueue();
    private store: SqliteStore | undefined;
    private content: Content | undefined;
    private jobs: JobRunner | undefined;
    private lock: FileHandle | undefined;
    private workspace = '';
    private accepting = false;
    private starting = false;
    private readonly listeners = new Set<() => void>();
    constructor(private readonly deps: Dependencies) { }
    private wake() { for (const fn of [...this.listeners])
        fn(); }
    private available(): SqliteStore { if (!this.store)
        fail('unavailable', 'Engine is stopped'); return this.store; }
    private context(raw: unknown) { const ctx = this.contract.read<CallContext>('call-context', raw); if (ctx.contractVersion !== CONTRACT_VERSION)
        fail('unsupported', 'Contract version is not supported'); return ctx; }
    private authorize(ctx: CallContext, effect: 'read' | 'collaborate' | 'admin', channels: CallContext['channel'][] = ['in_process', 'http', 'cli', 'mcp']) {
        if (!channels.includes(ctx.channel) || ['read', 'collaborate', 'admin'].indexOf(ctx.scope) < ['read', 'collaborate', 'admin'].indexOf(effect))
            fail('forbidden', 'Operation is not permitted');
    }
    private operation(ctx: CallContext, name: string, kind: 'command' | 'query') {
        const operation = this.contract.operations.get(name);
        if (!operation || operation.kind !== kind)
            fail('unsupported', 'Operation is not supported');
        this.authorize(ctx, operation.meta.effect, operation.meta.channels);
    }
    async start(dir: string) {
        if (this.store || this.lock || this.starting)
            fail('unavailable', 'Engine already started');
        this.starting = true;
        try {
            await mkdir(dir, { recursive: true });
            this.workspace = await realpath(dir);
            const path = join(this.workspace, '.engine.lock');
            try {
                this.lock = await open(path, 'wx', 0o600);
            }
            catch (error) {
                if (!isCode(error, 'EEXIST'))
                    throw error;
                const owner = await readFile(path, 'utf8').catch(() => '');
                const pid = Number(owner);
                if (!Number.isInteger(pid) || pid <= 0)
                    fail('unavailable', 'Workspace is locked');
                try {
                    process.kill(pid, 0);
                    fail('unavailable', 'Workspace is locked');
                }
                catch (probe) {
                    if (!isCode(probe, 'ESRCH'))
                        fail('unavailable', 'Workspace is locked');
                }
                await unlink(path);
                this.lock = await open(path, 'wx', 0o600);
            }
            await this.lock.writeFile(String(process.pid));
            await this.lock.sync();
            this.store = new SqliteStore(join(this.workspace, 'workspace.sqlite'), this.contract);
            this.content = new Content(this.store, this.contract, this.deps.clock, this.deps.ids);
            this.jobs = new JobRunner(this.store, this.deps.clock, action => this.queue.run(() => this.available().transaction(action)), { leaseMs: 30000, handlers: {} });
            await this.jobs.recover();
            this.accepting = true;
        }
        catch (error) {
            await this.cleanup();
            throwBoundary(error);
        }
        finally {
            this.starting = false;
        }
    }
    async drain(graceMs: number) {
        if (!Number.isFinite(graceMs) || graceMs < 0)
            fail('invalid', 'Invalid grace period');
        this.accepting = false;
        await this.queue.idle();
        await this.jobs?.drain(graceMs);
    }
    async stop() { if (!this.store && !this.lock)
        return; await this.drain(0); await this.cleanup(); }
    private async cleanup() {
        this.accepting = false;
        this.store?.close();
        this.store = undefined;
        this.content = undefined;
        this.jobs = undefined;
        this.wake();
        if (this.lock) {
            await this.lock.close();
            this.lock = undefined;
            await unlink(join(this.workspace, '.engine.lock')).catch(() => undefined);
        }
    }
    async command(rawCtx: CallContext, rawCmd: CommandEnvelope): Promise<CommandResult> {
        try {
            const ctx = this.context(rawCtx), cmd = this.contract.read<CommandEnvelope>('command-envelope', rawCmd);
            this.operation(ctx, cmd.type, 'command');
            if (!this.accepting)
                fail('unavailable', 'Engine is not accepting commands');
            return await this.queue.run(() => {
                const store = this.available();
                const existing = store.command(cmd.commandId);
                if (existing)
                    return existing;
                const result = store.transaction(() => {
                    let result: CommandResult;
                    try {
                        const validated = store.transaction(() => {
                            const output = this.dispatchCommand(ctx, cmd);
                            return this.contract.read<Json>('operations/' + cmd.type, output, '#/properties/result');
                        });
                        result = { ok: true, result: validated, seq: store.lastSeq() };
                    }
                    catch (error) {
                        result = { ok: false, error: errorOf(error) };
                    }
                    store.saveCommand(cmd.commandId, result);
                    return result;
                });
                this.wake();
                return result;
            });
        }
        catch (error) {
            return { ok: false, error: errorOf(error) };
        }
    }
    private dispatchCommand(ctx: CallContext, cmd: CommandEnvelope): unknown {
        const content = this.content;
        if (!content)
            fail('unavailable', 'Engine is stopped');
        switch (cmd.type) {
            case 'vc.CreateArtifact': {
                const p = this.contract.read<VcCreateArtifactOperation['payload']>('operations/' + cmd.type, cmd.payload, '#/properties/payload');
                return content.create(p.title, ctx.principal);
            }
            case 'vc.ImportContent': {
                const p = this.contract.read<VcImportContentOperation['payload']>('operations/' + cmd.type, cmd.payload, '#/properties/payload');
                const r = content.import(p, ctx.principal);
                return { artifactId: r.artifactId, version: r.version, ...('idMap' in r ? { idMap: r.idMap } : {}) };
            }
            case 'vc.RestoreVersion': {
                const p = this.contract.read<VcRestoreVersionOperation['payload']>('operations/' + cmd.type, cmd.payload, '#/properties/payload');
                const r = content.restore(p.artifactId, p.version, ctx.principal);
                return { artifactId: r.artifactId, version: r.version };
            }
            default: fail('unsupported', 'Operation is not supported');
        }
    }
    async query(rawCtx: CallContext, rawQ: QueryEnvelope): Promise<Json> {
        try {
            const ctx = this.context(rawCtx), q = this.contract.read<QueryEnvelope>('query-envelope', rawQ);
            this.operation(ctx, q.name, 'query');
            await this.queue.idle();
            const result = this.dispatchQuery(q);
            return this.contract.read<Json>('operations/' + q.name, result, '#/properties/result');
        }
        catch (error) {
            throwBoundary(error);
        }
    }
    private dispatchQuery(q: QueryEnvelope): unknown {
        const store = this.available();
        const read = <T>() => this.contract.read<T>('operations/' + q.name, q.args, '#/properties/payload');
        switch (q.name) {
            case 'sys.Capabilities': {
                read();
                const operations = [...this.contract.operations].map(([name, operation]) => ({ name, ...operation, supported: true }));
                for (const group of unsupportedGroups)
                    for (const kind of ['command', 'query'] satisfies ('command' | 'query')[])
                        for (const name of (kind === 'command' ? group.commands : group.queries).split(' ').filter(Boolean)) {
                            const effect = kind === 'query' ? 'read' : group.effect ?? 'collaborate';
                            operations.push({ name: group.prefix + '.' + name, kind, supported: false, meta: { effect, irreversible: ['Purge', 'RestoreBackup'].includes(name), channels: effect === 'admin' ? ['in_process', 'http', 'cli'] : ['in_process', 'http', 'cli', 'mcp'] } });
                        }
                return { contractVersion: CONTRACT_VERSION, mediaKinds: ['doc'], operations };
            }
            case 'vc.Artifact': return store.artifact(read<VcArtifactOperation['payload']>().artifactId);
            case 'vc.Outline': {
                const p = read<VcOutlineOperation['payload']>();
                return outline(store.elements(p.artifactId, p.version));
            }
            case 'vc.Elements': {
                const p = read<VcElementsOperation['payload']>(), elements = store.elements(p.artifactId, p.version);
                return p.elementIds ? elements.filter(e => p.elementIds!.includes(e.elementId)) : elements;
            }
            case 'vc.Versions': return store.versions(read<VcArtifactOperation['payload']>().artifactId);
            case 'vc.Diff': {
                const p = read<VcDiffOperation['payload']>();
                return diffVersions(store, p.artifactId, p.from, p.to);
            }
            case 'vc.ResolveAnchors': return resolveAnchors(store, read<VcResolveAnchorsOperation['payload']>().anchors);
            default: fail('unsupported', 'Operation is not supported');
        }
    }
    subscribe(rawCtx: CallContext, rawSub: Subscription): AsyncIterable<EventEnvelope> {
        const currentStore = () => this.store;
        const listeners = this.listeners;
        let ctx: CallContext, sub: Subscription;
        try {
            ctx = this.context(rawCtx);
            sub = this.contract.read<Subscription>('subscription', rawSub);
            this.authorize(ctx, 'read');
            this.available();
        }
        catch (error) {
            throwBoundary(error);
        }
        let cursor = sub.afterSeq, ended = false, wakeup: (() => void) | undefined;
        const iterator: AsyncIterableIterator<EventEnvelope> = {
            [Symbol.asyncIterator]() { return this; },
            async next() {
                try {
                    while (!ended && currentStore()) {
                        for (const event of currentStore()!.eventsAfter(cursor)) {
                            cursor = event.seq;
                            const filter = sub.filter;
                            if (filter?.types && !filter.types.includes(event.type))
                                continue;
                            if (filter?.artifactIds && (event.entity.kind !== 'artifact' || !filter.artifactIds.includes(event.entity.id)))
                                continue;
                            if (filter?.sessionIds)
                                continue;
                            return { done: false, value: event };
                        }
                        await new Promise<void>(resolve => { wakeup = () => { listeners.delete(wakeup!); resolve(); }; listeners.add(wakeup); });
                    }
                    return { done: true, value: undefined };
                }
                catch (error) {
                    throwBoundary(error);
                }
            },
            async return() { ended = true; wakeup?.(); return { done: true, value: undefined }; }
        };
        return iterator;
    }
    async putBlob(rawCtx: CallContext, bytes: Uint8Array, mediaType: string): Promise<string> {
        try {
            const ctx = this.context(rawCtx);
            this.authorize(ctx, 'collaborate');
            this.available();
            if (!this.accepting)
                fail('unavailable', 'Engine is draining');
            if (!(bytes instanceof Uint8Array) || typeof mediaType !== 'string' || !mediaType.length)
                fail('invalid', 'Invalid blob');
            const snapshot = Uint8Array.from(bytes), hash = createHash('sha256').update(snapshot).digest('hex');
            await this.queue.run(async () => {
                const dir = join(this.workspace, 'blobs', hash.slice(0, 2), hash.slice(2, 4));
                await mkdir(dir, { recursive: true });
                const path = join(dir, hash), temporary = join(dir, hash + '.' + this.deps.ids.next('blob_'));
                const file = await open(temporary, 'wx', 0o600);
                try {
                    await file.writeFile(snapshot);
                    await file.sync();
                    await file.close();
                    await rename(temporary, path);
                }
                catch (error) {
                    await file.close().catch(() => undefined);
                    await unlink(temporary).catch(() => undefined);
                    throw error;
                }
            });
            return hash;
        }
        catch (error) {
            throwBoundary(error);
        }
    }
    async getBlob(rawCtx: CallContext, hash: string): Promise<Uint8Array> {
        try {
            const ctx = this.context(rawCtx);
            this.authorize(ctx, 'read');
            this.available();
            if (!/^[a-f0-9]{64}$/.test(hash))
                fail('invalid', 'Invalid blob hash');
            await this.queue.idle();
            const bytes = await readFile(join(this.workspace, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash));
            if (createHash('sha256').update(bytes).digest('hex') !== hash)
                fail('internal', 'Blob integrity check failed');
            return new Uint8Array(bytes);
        }
        catch (error) {
            if (isCode(error, 'ENOENT'))
                fail('not_found', 'Blob not found');
            throwBoundary(error);
        }
    }
}
function isCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
function throwBoundary(error: unknown): never { const e = errorOf(error); fail(e.code, e.message, e.details); }
