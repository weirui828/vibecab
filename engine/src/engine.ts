import { open, mkdir, readFile, unlink, realpath, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Contract, CONTRACT_VERSION, errorOf, fail } from '../../contract/src/index.js';
import type { CallContext, CommandEnvelope, CommandResult, EventEnvelope, Json, QueryEnvelope, Subscription, ProviderModel, AgentTurn, ContextManifest, FeedbackComment, FeedbackConflict, Agreement, Update, Job, VcCreateArtifactOperation, VcImportContentOperation, VcRestoreVersionOperation, VcArtifactOperation, VcOutlineOperation, VcElementsOperation, VcDiffOperation, VcResolveAnchorsOperation } from '../../contract/src/index.js';
import { unsupportedGroups } from '../../contract/src/catalog.js';
import { SqliteStore } from './storage/sqlite.js';
import { Content } from './content/content.js';
import { outline, diffVersions, resolveAnchors } from './content/diff.js';
import { defaults } from './kernel/dependencies.js';
import type { Dependencies } from './kernel/dependencies.js';
import { SerialQueue } from './kernel/queue.js';
import { JobRunner } from './kernel/jobs.js';
import { Feedback } from './feedback/feedback.js';
import { BudgetLedger } from './gateway/ledger.js';
import { ProviderGateway } from './gateway/gateway.js';
import { OpenAICompatibleProvider } from './gateway/providers/openai-compatible.js';
import { estimateInputTokens, estimateReservationMicros } from './gateway/ledger.js';
import { createHash } from 'node:crypto';
import type { ModelEvent as GatewayEvent, ModelRequest as GatewayRequest } from './gateway/types.js';
import type { SettingsDocument } from './gateway/types.js';
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
    private feedback: Feedback | undefined;
    private budgets: BudgetLedger | undefined;
    private gateway: ProviderGateway | undefined;
    private lock: FileHandle | undefined;
    private workspace = '';
    private accepting = false;
    private starting = false;
    private readonly listeners = new Set<() => void>();
    private workerTimer: ReturnType<typeof setInterval> | undefined;
    private readonly sessionTails = new Map<string, Promise<void>>();
    constructor(private readonly deps: Dependencies) { }
    private wake() { for (const fn of [...this.listeners])
        fn(); }
    private async serializeSession<T>(sessionId:string,action:()=>Promise<T>):Promise<T>{
        const previous=this.sessionTails.get(sessionId)??Promise.resolve();let release!:()=>void;const tail=new Promise<void>(resolve=>{release=resolve;});this.sessionTails.set(sessionId,tail);await previous;
        try{return await action();}finally{release();if(this.sessionTails.get(sessionId)===tail)this.sessionTails.delete(sessionId);}
    }
    private available(): SqliteStore { if (!this.store)
        fail('unavailable', 'Engine is stopped'); return this.store; }
    private recoverInterruptedJob(job:Job):void {
        const store=this.available(),payload=job.payload;if(typeof payload!=='object'||payload===null||Array.isArray(payload))return;
        if(job.kind==='agent.update'){
            const updateId=Reflect.get(payload,'updateId');if(typeof updateId!=='string')return;const raw=store.feedback('update',updateId);if(!raw)return;const update=this.contract.read<Update>('update',raw);
            if(['committed','partially_committed','failed','cancelled'].includes(update.status))return;
            for(const itemId of update.itemIds){const row=store.feedback('agreement',itemId);if(row){const agreement=this.contract.read<Agreement>('agreement',row);if(agreement.state==='scheduled')store.saveFeedback('agreement',itemId,this.contract.read<Json>('json',{...agreement,state:'agreed'}));}}
            store.saveFeedback('update',updateId,this.contract.read<Json>('json',{...update,status:'failed',itemResults:update.itemIds.map(itemId=>({itemId,status:'not_addressed',reason:'Update was interrupted; no changes were committed.'}))}));
        }else if(job.kind==='agent.reply'){
            const turnId=Reflect.get(payload,'turnId');if(typeof turnId!=='string')return;const raw=store.feedback('agent-turn',turnId);if(!raw)return;const turn=this.contract.read<AgentTurn>('agent-turn',raw);
            if(turn.status==='queued')store.enqueue('agent.reply',this.deps.ids.next('reply_retry_'),this.contract.read<Json>('json',payload),this.deps.clock.now());
            else if(turn.status==='running')store.saveFeedback('agent-turn',turnId,this.contract.read<Json>('json',{...turn,status:'uncertain',completedAt:this.deps.clock.now()}));
        }
    }
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
            this.feedback = new Feedback(this.store, this.contract, this.deps.clock, this.deps.ids, () => this.settings());
            this.budgets = new BudgetLedger(this.store, this.deps.clock, this.contract, () => this.settings().budgets.localTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, () => this.settings().budgets.defaultTurnLimitMicros);
            this.gateway = new ProviderGateway(this.settings().models, { 'openai-compatible': new OpenAICompatibleProvider(this.deps.keyStore), ...this.deps.modelProviders }, this.budgets, this.contract, this.deps.clock);
            this.jobs = new JobRunner(this.store, this.deps.clock, action => this.queue.run(() => this.available().transaction(action)), { leaseMs: 30000, handlers: { 'agent.reply': job => this.runReply(job), 'agent.trigger': job => this.runTrigger(job), 'agent.update.trigger': job => this.runUpdateTrigger(job), 'agent.update': job => this.runUpdate(job) }, onInterrupted: job => this.recoverInterruptedJob(job), onUncertain: job => {
                const payload = job.payload;
                if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
                    const reservationId = Reflect.get(payload, 'reservationId');
                    if (typeof reservationId === 'string') this.budgets?.markUncertain(reservationId);
                    if(job.kind==='agent.reply'){const turnId=Reflect.get(payload,'turnId');if(typeof turnId==='string'){const raw=this.available().feedback('agent-turn',turnId);if(raw){const turn=this.contract.read<AgentTurn>('agent-turn',raw);if(turn.status==='running')this.available().saveFeedback('agent-turn',turnId,this.contract.read<Json>('json',{...turn,status:'uncertain',completedAt:this.deps.clock.now()}));}}}
                }
            } });
            await this.jobs.recover();
            this.accepting = true;
            this.workerTimer = setInterval(() => { void this.jobs?.tick(); }, 15);
            this.workerTimer.unref();
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
        if (this.workerTimer) clearInterval(this.workerTimer);
        this.workerTimer = undefined;
        this.store?.close();
        this.store = undefined;
        this.content = undefined;
        this.feedback = undefined;
        this.budgets = undefined;
        this.gateway = undefined;
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
                if (result.ok && (cmd.type === 'sys.SetSettings' || cmd.type === 'sys.SetProviderKeyRef')) this.gateway?.setModels(this.settings().models);
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
        const store = this.store;
        if (!content || !store)
            fail('unavailable', 'Engine is stopped');
        switch (cmd.type) {
            case 'sys.SetSettings': {
                const p = this.contract.read<{ patch: { models?: Record<string, ProviderModel>; budgets?: SettingsDocument['budgets']; sessions?: Record<string, Json> } }>('operations/sys.SetSettings', cmd.payload, '#/properties/payload');
                const current = this.settings(), budgets = { ...current.budgets, ...p.patch.budgets };
                if (budgets.localTimeZone !== undefined) { try { new Intl.DateTimeFormat('en', { timeZone: budgets.localTimeZone }); } catch { fail('invalid', 'Invalid local time zone'); } }
                const settings = this.saveSettings({ models: { ...current.models, ...p.patch.models }, budgets, sessions: { ...current.sessions, ...p.patch.sessions } });
                store.appendEvent({ ts: this.deps.clock.now(), type: 'sys.SettingsChanged', entity: { kind: 'settings', id: 'workspace' }, payload: this.contract.read<Json>('events/sys.SettingsChanged', { settings }) });
                return { settings };
            }
            case 'sys.SetProviderKeyRef': {
                const p = this.contract.read<{ alias: string; keyRef: string }>('operations/sys.SetProviderKeyRef', cmd.payload, '#/properties/payload'), current = this.settings(), model = current.models[p.alias];
                if (!model) fail('not_found', 'Model alias not found');
                this.saveSettings({ ...current, models: { ...current.models, [p.alias]: { ...model, keyRef: p.keyRef } } });
                store.appendEvent({ ts: this.deps.clock.now(), type: 'sys.ProviderKeyRefSet', entity: { kind: 'model', id: p.alias }, payload: this.contract.read<Json>('events/sys.ProviderKeyRefSet', p) });
                return p;
            }
            case 'sys.SetBudget': {
                const p = this.contract.read<{ account: { kind: 'daily' | 'session' | 'grant' | 'run' | 'turn'; key?: string }; limitMicros: number | null }>('operations/sys.SetBudget', cmd.payload, '#/properties/payload');
                const budgets = this.budgets; if (!budgets) fail('unavailable', 'Budget ledger is not started');
                const state = budgets.setLimit(p.account, p.limitMicros);
                store.appendEvent({ ts: this.deps.clock.now(), type: 'sys.BudgetChanged', entity: { kind: 'budget', id: `${state.account.kind}:${state.account.key ?? ''}` }, payload: this.contract.read<Json>('events/sys.BudgetChanged', { account: state.account, limitMicros: state.limitMicros }) });
                return { state };
            }
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
                for (const agreement of store.feedbackList('agreement').map(x => this.contract.read<Agreement>('agreement', x)).filter(a => a.state === 'applied' && a.appliedVersion !== undefined && a.appliedVersion > p.version)) {
                    const rawComment = store.feedback('comment', agreement.commentId); if (!rawComment) continue;
                    const comment = this.contract.read<FeedbackComment>('feedback-comment', rawComment); if (comment.anchor?.artifactId !== p.artifactId) continue;
                    store.saveFeedback('agreement', agreement.agreementId, this.contract.read<Json>('agreement', { ...agreement, revertedInVersion: r.version }));
                    this.feedback?.systemNotice(comment.sessionId, comment.threadId, `The Update applied in version ${agreement.appliedVersion} was reverted by restoring version ${p.version}. Re-agree if you still want this change.`);
                }
                return { artifactId: r.artifactId, version: r.version };
            }
            case 'vc.CaptureIdea': case 'vc.CreateProject': case 'vc.StartSession': case 'vc.AttachArtifact':
            case 'vc.PauseSession': case 'vc.ResumeSession': case 'vc.EndSession': case 'vc.Comment':
            case 'vc.EditComment': case 'vc.DeleteComment': case 'vc.Agree': case 'vc.Decline':
            case 'vc.ResolveConflict': case 'vc.SetReplyTrigger': case 'vc.MarkHandled':
                if (!this.feedback) fail('unavailable', 'Engine is stopped');
                return this.feedback.command(cmd.type, cmd.payload, ctx.principal);
            case 'vc.CreateGrant': {
                if (ctx.principal.kind !== 'human') fail('forbidden', 'Grant management requires a human principal');
                const p = this.contract.read<{scope: {sessionIds?: string[]; artifactIds?: string[]}; capabilities: string[]; limits: {spendMicros?: number; maxReviews?: number}; expiresAt?: string}>('operations/vc.CreateGrant', cmd.payload, '#/properties/payload');
                const grantId = this.deps.ids.next('grant_');
                store.saveFeedback('grant', grantId, this.contract.read<Json>('grant', { grantId, ...p })); return { grantId };
            }
            case 'vc.RevokeGrant': {
                if (ctx.principal.kind !== 'human') fail('forbidden', 'Grant management requires a human principal');
                const p = this.contract.read<{grantId: string}>('operations/vc.RevokeGrant', cmd.payload, '#/properties/payload');
                const grant = store.feedback('grant', p.grantId); if (!grant) fail('not_found', 'Grant not found');
                const parsed = this.contract.read<Record<string, Json>>('grant', grant);
                store.saveFeedback('grant', p.grantId, this.contract.read<Json>('grant', { ...parsed, revokedAt: this.deps.clock.now() })); return p;
            }
            case 'vc.AskAgent': if(ctx.principal.kind!=='human')fail('forbidden','AskAgent requires a human principal'); return this.askAgent(cmd.payload);
            case 'vc.StartUpdate': if(ctx.principal.kind!=='human')fail('forbidden','StartUpdate requires a human principal'); return this.startUpdate(cmd.payload);
            case 'vc.HoldElement': {
                if(ctx.principal.kind!=='human')fail('forbidden','Direct editing requires a human principal');
                const p = this.contract.read<{artifactId:string;elementId:string}>('operations/vc.HoldElement', cmd.payload, '#/properties/payload');
                if (!this.directEditingEnabled(p.artifactId)) fail('forbidden', 'Direct editing is disabled for this artifact');
                if (this.activeUpdateTouches(p.artifactId,p.elementId)) fail('locked', 'Element is in an active Update write set');
                const element = store.elements(p.artifactId).find(x => x.elementId === p.elementId); if (!element) fail('not_found', 'Element not found');
                const key = `${p.artifactId}:${p.elementId}`, existing = store.feedback('hold', key);
                if (existing && this.activeHold(existing)) fail('locked', 'Element is already held');
                const now = this.deps.clock.now(); store.saveFeedback('hold', key, this.contract.read<Json>('hold', { ...p, heldAt: now, lastActivity: now })); return { ...p, heldAt: now };
            }
            case 'vc.SaveElement': {
                if(ctx.principal.kind!=='human')fail('forbidden','Direct editing requires a human principal');
                const p = this.contract.read<{artifactId:string;elementId:string;baseVersion:number;element:import('../../contract/src/index.js').ElementDraft}>('operations/vc.SaveElement', cmd.payload, '#/properties/payload');
                if (!this.directEditingEnabled(p.artifactId)) fail('forbidden', 'Direct editing is disabled for this artifact');
                if (this.activeUpdateTouches(p.artifactId,p.elementId)) fail('locked', 'Element is in an active Update write set');
                const key = `${p.artifactId}:${p.elementId}`, rawHold = store.feedback('hold', key); if (!rawHold || !this.activeHold(rawHold)) fail('locked', 'A current element hold is required');
                const current = store.elements(p.artifactId, p.baseVersion).find(x => x.elementId === p.elementId); if (!current) fail('not_found', 'Element not found at base version');
                const committed = content.commit({ artifactId:p.artifactId, baseVersion:p.baseVersion, changes:[{op:'update',elementId:p.elementId,element:p.element}], createdBy:ctx.principal, source:{editId:this.deps.ids.next('edit_')} });
                const hold = this.contract.read<{artifactId:string;elementId:string;heldAt:string;lastActivity:string}>('hold', rawHold); store.saveFeedback('hold', key, this.contract.read<Json>('hold', { ...hold, lastActivity:this.deps.clock.now() })); return { artifactId:p.artifactId, elementId:p.elementId, version:committed.version };
            }
            case 'vc.ReleaseHold': {
                if(ctx.principal.kind!=='human')fail('forbidden','Direct editing requires a human principal');
                const p = this.contract.read<{artifactId:string;elementId:string}>('operations/vc.ReleaseHold', cmd.payload, '#/properties/payload'), key = `${p.artifactId}:${p.elementId}`, rawHold = store.feedback('hold', key);
                if (!rawHold) fail('not_found', 'Element hold not found'); const hold = this.contract.read<Record<string,Json>>('hold', rawHold);
                store.saveFeedback('hold', key, this.contract.read<Json>('hold', { ...hold, releasedAt:this.deps.clock.now() })); return p;
            }
            case 'vc.CancelUpdate': if(ctx.principal.kind!=='human')fail('forbidden','CancelUpdate requires a human principal'); return this.cancelUpdate(cmd.payload);
            case 'vc.ApprovePlan': if(ctx.principal.kind!=='human')fail('forbidden','ApprovePlan requires a human principal'); return this.approvePlan(cmd.payload, cmd.commandId);
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
            case 'sys.Settings': read(); return this.settings();
            case 'sys.Usage': {
                read(); const budgets = this.budgets; if (!budgets) fail('unavailable', 'Budget ledger is not started');
                return { accounts: budgets.states(), calls: budgets.calls() };
            }
            case 'sys.Budgets': {
                read(); const budgets = this.budgets; if (!budgets) fail('unavailable', 'Budget ledger is not started');
                return budgets.states();
            }
            case 'vc.Ideas': case 'vc.Projects': case 'vc.Sessions': case 'vc.Threads': case 'vc.FeedbackItems':
            case 'vc.DecisionRecord': case 'vc.Conflicts': case 'vc.AttentionInbox':
                if (!this.feedback) fail('unavailable', 'Engine is stopped');
                return this.feedback.query(q.name, q.args);
            case 'vc.AgentTurns': case 'vc.Manifest': case 'vc.DeliveryState': case 'vc.Grants': {
                this.contract.read('operations/' + q.name, q.args, '#/properties/payload');
                if (q.name === 'vc.AgentTurns') { const p = this.contract.read<{sessionId?: string}>('operations/vc.AgentTurns', q.args, '#/properties/payload'); return store.feedbackList('agent-turn').map(x => this.contract.read<AgentTurn>('agent-turn', x)).filter(x => !p.sessionId || x.sessionId === p.sessionId); }
                if (q.name === 'vc.Manifest') { const p = this.contract.read<{turnId: string}>('operations/vc.Manifest', q.args, '#/properties/payload'); return store.feedbackList('manifest').map(x => this.contract.read<ContextManifest>('context-manifest', x)).filter(x => x.turnId === p.turnId); }
                if (q.name === 'vc.Grants') return store.feedbackList('grant');
                const p = this.contract.read<{commentIds: string[]}>('operations/vc.DeliveryState', q.args, '#/properties/payload'); return p.commentIds.map(commentId => store.feedback('delivery-state', commentId) ?? {commentId, state: 'saved', updatedAt: this.deps.clock.now()});
            }
            case 'vc.Updates': case 'vc.UpdateDetail': {
                if (q.name === 'vc.Updates') { const p = this.contract.read<{artifactId?: string}>('operations/vc.Updates', q.args, '#/properties/payload'); return store.feedbackList('update').map(x => this.contract.read<Update>('update', x)).filter(x => !p.artifactId || x.artifactId === p.artifactId); }
                const p = this.contract.read<{updateId: string}>('operations/vc.UpdateDetail', q.args, '#/properties/payload'); const found = store.feedback('update', p.updateId); if (!found) fail('not_found', 'Update not found'); return this.contract.read<Update>('update', found);
            }
            default: fail('unsupported', 'Operation is not supported');
        }
    }
    private settings(): SettingsDocument {
        const value = this.available().feedback('settings', 'workspace');
        return this.contract.read<SettingsDocument>('settings', value ?? { models: {}, budgets: {}, sessions: {} });
    }
    private saveSettings(value: unknown): SettingsDocument {
        const settings = this.contract.read<SettingsDocument>('settings', value);
        this.available().saveFeedback('settings', 'workspace', this.contract.read<Json>('json', settings));
        return settings;
    }
    private askAgent(raw: unknown): { turnId: string } {
        const store = this.available(), p = this.contract.read<{sessionId: string; threadIds?: string[]}>('operations/vc.AskAgent', raw, '#/properties/payload');
        const session = store.feedback('session', p.sessionId); if (!session) fail('not_found', 'Session not found');
        const sessionRecord = this.contract.read<Record<string, Json>>('session', session);
        if (sessionRecord.state !== 'active') fail('conflict', 'Agent replies require an active session');
        const all = store.feedbackList('comment').map(x => this.contract.read<FeedbackComment>('feedback-comment', x));
        const selected = all.filter(c => c.sessionId === p.sessionId && !c.deleted && c.author.kind === 'human' && (p.threadIds === undefined || p.threadIds.includes(c.threadId)));
        if (!selected.length) fail('not_found', 'No human comments match the requested threads');
        return this.queueReplyTurn(p.sessionId, selected, 'manual', p.threadIds);
    }
    private directEditingEnabled(artifactId: string): boolean {
        return this.available().feedbackList('attachment').map(x => this.contract.read<{sessionId:string;artifactId:string}>('session-artifact', x)).some(link => link.artifactId === artifactId && this.settings().sessions[link.sessionId]?.directEditing === true);
    }
    private activeHold(raw: unknown): boolean {
        const hold = this.contract.read<{heldAt:string;lastActivity:string;releasedAt?:string}>('hold', raw);
        if (hold.releasedAt) return false;
        const artifactId = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? Reflect.get(raw, 'artifactId') : undefined;
        const attached = typeof artifactId === 'string' ? this.available().feedbackList('attachment').map(x => this.contract.read<{sessionId:string;artifactId:string}>('session-artifact', x)).filter(x => x.artifactId === artifactId) : [];
        const timeout = attached.map(x => this.settings().sessions[x.sessionId]?.holdIdleMinutes).find((value): value is number => value !== undefined) ?? 30;
        return Date.parse(this.deps.clock.now()) - Date.parse(hold.lastActivity) < timeout * 60_000;
    }
    private hasJobLease(job:Job):boolean {const current=this.available().jobs().find(candidate=>candidate.id===job.id);return current?.state==='leased'&&current.attempts===job.attempts;}
    private activeUpdateTouches(artifactId:string,elementId:string):boolean {
        const store=this.available();
        for(const raw of store.feedbackList('update')){
            const update=this.contract.read<Update>('update',raw);if(update.artifactId!==artifactId||!['queued','planning','awaiting_plan_review','writing','checking'].includes(update.status))continue;
            if(update.plan){const plan=this.contract.read<import('../../contract/src/index.js').UpdatePlan>('update-plan',update.plan);if(plan.items.some(item=>item.elementIds.includes(elementId)||item.newUnder?.includes(elementId)))return true;}
        }
        return false;
    }
    private queueReplyTurn(sessionId: string, selected: FeedbackComment[], mode: 'manual'|'realtime'|'batch', threadIds?: string[]): {turnId: string} {
        const store = this.available(), turnId = this.deps.ids.next('turn_'), settings = this.settings(), modelRef = settings.models.reply ? 'reply' : 'default';
        const turn = this.contract.read<AgentTurn>('agent-turn', { turnId, sessionId, kind: 'reply', trigger: { mode, commentIds: selected.map(c => c.commentId), ...(threadIds ? { threadIds } : {}) }, manifestId: this.deps.ids.next('manifest_'), status: 'queued', createdAt: this.deps.clock.now() });
        store.saveFeedback('agent-turn', turnId, this.contract.read<Json>('json', turn));
        for (const c of selected) store.saveFeedback('delivery-state', c.commentId, this.contract.read<Json>('delivery-state', { commentId: c.commentId, state: 'queued', turnId, updatedAt: this.deps.clock.now() }));
        store.enqueue('agent.reply', turnId, this.contract.read<Json>('json', { turnId, modelRef }), this.deps.clock.now());
        return { turnId };
    }
    private async runTrigger(job: Job): Promise<void> {
        const payload = job.payload; if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
        const sessionId = Reflect.get(payload, 'sessionId'), mode = Reflect.get(payload, 'mode');
        if (typeof sessionId !== 'string' || (mode !== 'realtime' && mode !== 'batch')) return;
        await this.queue.run(() => this.available().transaction(() => {
            const store = this.available(), active = store.feedbackList('agent-turn').map(x => this.contract.read<AgentTurn>('agent-turn', x)).some(t => t.sessionId === sessionId && ['queued','running'].includes(t.status));
            const comments = store.feedbackList('comment').map(x => this.contract.read<FeedbackComment>('feedback-comment', x)).filter(c => c.sessionId === sessionId && c.author.kind === 'human' && !c.deleted && this.contract.read<{commentId:string;state:string;updatedAt:string}>('delivery-state', store.feedback('delivery-state', c.commentId) ?? {commentId:c.commentId,state:'saved',updatedAt:c.createdAt}).state === 'saved');
            if (!comments.length) return;
            if(active){store.enqueue('agent.trigger',this.deps.ids.next('trigger_'),this.contract.read<Json>('json',{sessionId,mode,notBefore:new Date(Date.parse(this.deps.clock.now())+1000).toISOString()}),this.deps.clock.now());return;}
            const now = Date.parse(this.deps.clock.now()), prefs = this.settings().sessions[sessionId] ?? {}, latest = Math.max(...comments.map(c => Date.parse(c.createdAt)));
            let effectiveMode: 'realtime'|'batch' = mode;
            const recentTurns = store.feedbackList('agent-turn').map(x => this.contract.read<AgentTurn>('agent-turn', x)).filter(t => t.sessionId === sessionId && t.trigger.mode === 'realtime' && now - Date.parse(t.createdAt) < 3_600_000).length;
            const rateLimit = prefs.replyRateLimitPerHour ?? 20;
            if (mode === 'realtime' && recentTurns >= rateLimit) {
                effectiveMode = 'batch';
                this.feedback?.systemNotice(sessionId, comments[0]!.threadId, 'Realtime replies reached the session rate limit. New comments will be handled in batch mode.');
            }
            if (effectiveMode === 'realtime' && now < latest + (prefs.realtimeDebounceSeconds ?? this.settings().budgets.realtimeDebounceSeconds ?? 8) * 1000) return;
            if (effectiveMode === 'batch' && comments.length < (prefs.batchCommentThreshold ?? 5) && now < latest + (prefs.batchIdleMinutes ?? 10) * 60_000) return;
            this.queueReplyTurn(sessionId, comments, effectiveMode);
        }));
    }
    private async runUpdateTrigger(job: Job): Promise<void> {
        const payload = job.payload; if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
        const artifactId = Reflect.get(payload, 'artifactId'); if (typeof artifactId !== 'string') return;
        await this.queue.run(() => this.available().transaction(() => {
            try { this.startUpdate({ artifactId }); } catch (error) { if (errorOf(error).code !== 'not_found' && errorOf(error).code !== 'locked') throw error; }
        }));
    }
    private async runReply(job: Job): Promise<void> {
        const payload=job.payload;if(typeof payload!=='object'||payload===null||Array.isArray(payload))fail('invalid','Invalid agent job');const turnId=Reflect.get(payload,'turnId');if(typeof turnId!=='string')fail('invalid','Invalid agent job');
        const turn=this.contract.read<AgentTurn>('agent-turn',this.available().feedback('agent-turn',turnId));
        await this.serializeSession(turn.sessionId,()=>this.runReplyWork(job));
    }
    private async runReplyWork(job: Job): Promise<void> {
        const store = this.available(), payload = job.payload;
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) fail('invalid', 'Invalid agent job');
        const turnId = Reflect.get(payload, 'turnId'), modelRef = Reflect.get(payload, 'modelRef');
        if (typeof turnId !== 'string' || typeof modelRef !== 'string') fail('invalid', 'Invalid agent job');
        const turn = this.contract.read<AgentTurn>('agent-turn', store.feedback('agent-turn', turnId));
        const selected = turn.trigger.commentIds.map(id => store.feedback('comment', id)).filter((x): x is Json => x !== undefined).map(x => this.contract.read<FeedbackComment>('feedback-comment', x));
        const prompt = await readFile(new URL('./agent/prompts/reply.md', import.meta.url), 'utf8');
        const promptHash = createHash('sha256').update(prompt).digest('hex');
        const messages: GatewayRequest['messages'] = [{ role: 'system', content: prompt }, { role: 'user', content: '<untrusted-comments>\n' + selected.map(c => `${c.author.kind}: ${c.body}`).join('\n') + '\n</untrusted-comments>' }];
        const manifestId = turn.manifestId;
        const manifest = this.contract.read<ContextManifest>('context-manifest', { manifestId, turnId, requestIndex: 0, items: [{ kind: 'system_prompt', id: 'reply.md', hash: promptHash, tokens: Math.ceil(prompt.length / 3), reason: 'reply prompt' }, ...selected.map(c => ({ kind: 'comment' as const, id: c.commentId, hash: createHash('sha256').update(JSON.stringify(c)).digest('hex'), tokens: Math.ceil(c.body.length / 3), reason: 'triggering comment' }))], dropped: [], promptHash, createdAt: this.deps.clock.now() });
        await this.queue.run(() => store.transaction(() => store.saveFeedback('manifest', manifestId, this.contract.read<Json>('json', manifest))));
        const toolNames=['read_elements','outline','search','reply','suggest_review'];
        const schemas=new Map(toolNames.map(name=>[name,this.contract.schema(`agent-tools/${name}`)]));
        const turnLimit=this.settings().sessions[turn.sessionId]?.tokenLimit??this.settings().budgets.defaultTurnTokenLimit??8192;
        const request: GatewayRequest = { modelRef, messages, tools: toolNames.map(name=>({name,description:name.replaceAll('_',' '),parameters:schemas.get(name)!})), maxOutputTokens: Math.min(1200,turnLimit) };
        if(estimateInputTokens(request)+request.maxOutputTokens>turnLimit)fail('budget_exceeded','Reply context exceeds its configured token limit');
        const model = this.settings().models[modelRef]; if (!model) { await this.queue.run(() => store.transaction(() => store.saveFeedback('agent-turn', turnId, this.contract.read<Json>('json', { ...turn, status: 'failed', errorCode: 'unsupported', completedAt: this.deps.clock.now() })))); return; }
        const reservationId = this.deps.ids.next('reservation_');
        const amount = estimateReservationMicros(request, model);
        this.budgets?.reserve(reservationId, [{ kind: 'turn', key: turnId }, { kind: 'session', key: turn.sessionId }, { kind: 'daily' }], amount);
        const abort = new AbortController(), events: GatewayEvent[] = [];
        try {
            const onSent=async()=>this.queue.run(()=>store.transaction(()=>{if(!this.hasJobLease(job))throw Error('Agent job lease expired');const current=this.contract.read<AgentTurn>('agent-turn',store.feedback('agent-turn',turnId));store.saveFeedback('agent-turn',turnId,this.contract.read<Json>('json',{...current,status:'running'}));for(const c of selected)store.saveFeedback('delivery-state',c.commentId,this.contract.read<Json>('delivery-state',{commentId:c.commentId,state:'delivered',turnId,updatedAt:this.deps.clock.now()}));}));
            for await (const event of this.gateway!.call(request, { reservationId, idempotencyKey: turnId + ':0', signal: abort.signal, onSent })) events.push(event);
            const toolResults: Array<{id:string; content:string; name:string}> = [];
            let toolCount = 0;
            for (const event of events) if (event.type === 'tool_call') {
                toolCount++;
                if (toolCount > (this.settings().sessions[turn.sessionId]?.toolCallLimit ?? this.settings().budgets.toolCallLimit ?? 12)) { toolResults.push({ id:event.call.id, name:event.call.name, content:'Tool call limit reached.' }); continue; }
                const schema = schemas.get(event.call.name);
                if (schema === undefined || !this.contract.validates(schema, event.call.arguments)) { toolResults.push({ id:event.call.id, name:event.call.name, content:'Unknown tool or invalid arguments.' }); continue; }
                const args = this.contract.read<Record<string, Json>>('json', event.call.arguments);
                let result: unknown = { error: 'Tool could not be completed.' };
                if (event.call.name === 'reply') {
                    const threadId = args.threadId, body = args.body;
                    if (typeof threadId === 'string' && typeof body === 'string') {
                        const thread = selected.find(c => c.threadId === threadId);
                        if (thread && thread.author.kind === 'human') {
                            const replyParent = typeof args.replyTo === 'string' ? selected.find(c => c.commentId === args.replyTo && c.threadId === threadId) : thread;
                            const proposal = args.proposal;
                            const proposalAllowed = proposal === undefined || Array.isArray(proposal) || (typeof proposal === 'object' && proposal !== null && !Array.isArray(proposal) && thread.anchor?.artifactId !== undefined && typeof Reflect.get(proposal, 'elementId') === 'string' && store.elements(thread.anchor.artifactId).some(e => e.elementId === Reflect.get(proposal, 'elementId')));
                            if (!replyParent || !proposalAllowed) result = { error: 'Reply reference or proposal is outside the selected thread.' };
                            else {
                                const posted = await this.queue.run(() => this.available().transaction(() => {
                                    if(!this.hasJobLease(job))return {error:'Agent turn lease expired.'};
                                    const comment = this.feedback!.agentReply({ sessionId: turn.sessionId, threadId, turnId, body, replyTo: replyParent.commentId, ...(proposal === undefined ? {} : { proposal }) });
                                    for (const c of selected.filter(x => x.threadId === threadId)) this.available().saveFeedback('delivery-state', c.commentId, this.contract.read<Json>('delivery-state', { commentId: c.commentId, state: 'replied', turnId, updatedAt: this.deps.clock.now() })); return comment;
                                })); result = posted;
                            }
                        } else result = { error: 'Reply thread is outside this turn context.' };
                    }
                } else if (event.call.name === 'read_elements' || event.call.name === 'outline') {
                    const artifactId = args.artifactId;
                    const attached = store.feedbackList('attachment').some(x => { const item = this.contract.read<{sessionId:string;artifactId:string}>('session-artifact', x); return item.sessionId === turn.sessionId && item.artifactId === artifactId; });
                    if (typeof artifactId === 'string' && attached) result = event.call.name === 'outline' ? outline(store.elements(artifactId)) : store.elements(artifactId, typeof args.version === 'number' ? args.version : undefined).filter(e => !Array.isArray(args.elementIds) || args.elementIds.includes(e.elementId));
                    else result = { error: 'Artifact is not attached to this session.' };
                } else if (event.call.name === 'search' && typeof args.query === 'string') {
                    result = store.search(turn.sessionId, args.query);
                } else if (event.call.name === 'suggest_review') {
                    const question = args.question, elementIds = args.elementIds;
                    if (typeof question === 'string' && Array.isArray(elementIds) && elementIds.every(id => typeof id === 'string')) {
                        const attachedIds = store.feedbackList('attachment').map(x => this.contract.read<{sessionId:string;artifactId:string}>('session-artifact', x)).filter(x => x.sessionId === turn.sessionId).map(x => x.artifactId);
                        const valid = attachedIds.flatMap(artifactId => store.elements(artifactId).map(e => e.elementId));
                        if (elementIds.every(id => valid.includes(id))) {
                            const draftId = this.deps.ids.next('review_draft_');
                            const saved=await this.queue.run(() => store.transaction(() => {if(!this.hasJobLease(job))return false;store.saveFeedback('review-draft', draftId, this.contract.read<Json>('json', { draftId, sessionId: turn.sessionId, question, elementIds, createdByTurnId: turnId, createdAt: this.deps.clock.now() }));return true;}));
                            result = saved ? { draftId, saved: true } : {error:'Agent turn lease expired.'};
                        } else result = { error: 'An element is outside the attached artifacts.' };
                    }
                }
                toolResults.push({ id:event.call.id, name:event.call.name, content:JSON.stringify(result) });
            }
            if (toolResults.length) {
                const calls = events.filter((event): event is Extract<GatewayEvent,{type:'tool_call'}> => event.type === 'tool_call').map(event => event.call);
                const followMessages: GatewayRequest['messages'] = [...messages, { role: 'assistant', content: '', toolCalls: calls }, ...toolResults.map(item => ({ role: 'tool' as const, toolCallId: item.id, content: item.content }))];
                const followRequest: GatewayRequest = { modelRef, messages: followMessages, maxOutputTokens: 600 };
                if(estimateInputTokens(followRequest)+followRequest.maxOutputTokens>turnLimit)fail('budget_exceeded','Reply tool context exceeds its configured token limit');
                const followItems = [...manifest.items, ...toolResults.map(item => ({ kind:'tool_result' as const, id:item.id, hash:createHash('sha256').update(item.content).digest('hex'), tokens:Math.ceil(item.content.length/3), reason:'tool result' }))];
                const followManifest = this.contract.read<ContextManifest>('context-manifest', { manifestId: this.deps.ids.next('manifest_'), turnId, requestIndex: 1, items: followItems, dropped: [], promptHash, createdAt: this.deps.clock.now() });
                await this.queue.run(() => store.transaction(() => store.saveFeedback('manifest', followManifest.manifestId, this.contract.read<Json>('json', followManifest))));
                const followReservationId = this.deps.ids.next('reservation_');
                this.budgets?.reserve(followReservationId, [{ kind: 'turn', key: turnId }, { kind: 'session', key: turn.sessionId }, { kind: 'daily' }], estimateReservationMicros(followRequest, model));
                for await (const ignored of this.gateway!.call(followRequest, { reservationId: followReservationId, idempotencyKey: turnId + ':1', signal: abort.signal })) void ignored;
            }
            const error = events.find((event): event is Extract<GatewayEvent,{type:'error'}> => event.type === 'error');
            await this.queue.run(() => this.available().transaction(() => {
                if(!this.hasJobLease(job))return;
                const status: AgentTurn['status'] = error ? (error.code === 'timeout' ? 'uncertain' : 'failed') : 'completed';
                const current = this.contract.read<AgentTurn>('agent-turn', this.available().feedback('agent-turn', turnId));
                this.available().saveFeedback('agent-turn', turnId, this.contract.read<Json>('json', { ...current, status, completedAt: this.deps.clock.now(), ...(error ? { errorCode: error.code } : {}) }));
            }));
        } catch {
            await this.queue.run(() => this.available().transaction(() => { if(!this.hasJobLease(job))return;const current = this.contract.read<AgentTurn>('agent-turn', this.available().feedback('agent-turn', turnId)); this.available().saveFeedback('agent-turn', turnId, this.contract.read<Json>('json', { ...current, status: 'uncertain', completedAt: this.deps.clock.now() })); }));
        }
    }
    private startUpdate(raw: unknown): {updateId: string; status: string} {
        const store = this.available(), p = this.contract.read<{artifactId:string}>('operations/vc.StartUpdate', raw, '#/properties/payload'), artifact = store.artifact(p.artifactId);
        const existing = store.feedbackList('update').map(x => this.contract.read<Update>('update', x)).find(x => x.artifactId === p.artifactId && ['queued','planning','awaiting_plan_review','writing','checking'].includes(x.status));
        if (existing) fail('locked', 'An Update is already active for this artifact');
        const agreements = store.feedbackList('agreement').map(x => this.contract.read<Agreement>('agreement', x)).filter(a => a.state === 'agreed' && store.feedback('comment', a.commentId) !== undefined && this.contract.read<FeedbackComment>('feedback-comment', store.feedback('comment', a.commentId)).anchor?.artifactId === p.artifactId);
        if (!agreements.length) fail('not_found', 'No agreed items target this artifact');
        const updateId = this.deps.ids.next('update_'), update = this.contract.read<Update>('update', { updateId, artifactId:p.artifactId, baseVersion:artifact.headVersion, itemIds:agreements.map(a=>a.agreementId), status:'queued', itemResults:[], createdAt:this.deps.clock.now() });
        store.saveFeedback('update', updateId, this.contract.read<Json>('json', update));
        for (const agreement of agreements) store.saveFeedback('agreement', agreement.agreementId, this.contract.read<Json>('json', { ...agreement, state:'scheduled' }));
        store.enqueue('agent.update', updateId, this.contract.read<Json>('json', { updateId }), this.deps.clock.now());
        return { updateId, status:'queued' };
    }
    private cancelUpdate(raw: unknown): {updateId:string;status:string} {
        const p=this.contract.read<{updateId:string}>('operations/vc.CancelUpdate',raw,'#/properties/payload'),store=this.available(),found=store.feedback('update',p.updateId);
        if(!found)fail('not_found','Update not found'); const update=this.contract.read<Update>('update',found);
        if(!['queued','planning','awaiting_plan_review','writing','checking'].includes(update.status))fail('conflict','Update can no longer be cancelled');
        for(const itemId of update.itemIds){const rawAgreement=store.feedback('agreement',itemId);if(rawAgreement){const agreement=this.contract.read<Agreement>('agreement',rawAgreement);store.saveFeedback('agreement',itemId,this.contract.read<Json>('json',{...agreement,state:'agreed'}));}}
        store.saveFeedback('update',p.updateId,this.contract.read<Json>('json',{...update,status:'cancelled'})); return {updateId:p.updateId,status:'cancelled'};
    }
    private approvePlan(raw: unknown, commandId: string): {updateId:string;status:string} {
        const p=this.contract.read<{updateId:string}>('operations/vc.ApprovePlan',raw,'#/properties/payload'),store=this.available(),found=store.feedback('update',p.updateId);
        if(!found)fail('not_found','Update not found'); const update=this.contract.read<Update>('update',found);
        if(update.status!=='awaiting_plan_review'||!update.plan)fail('conflict','Update is not waiting for plan review');
        store.saveFeedback('update',p.updateId,this.contract.read<Json>('json',{...update,status:'writing'}));
        store.enqueue('agent.update',this.deps.ids.next('update_job_'),this.contract.read<Json>('json',{updateId:p.updateId,approvedBy:commandId}),this.deps.clock.now()); return {updateId:p.updateId,status:'writing'};
    }
    private async runUpdate(job: Job): Promise<void> {
        const payload=job.payload;if(typeof payload!=='object'||payload===null||Array.isArray(payload))return;
        const updateId=Reflect.get(payload,'updateId');if(typeof updateId!=='string')return;
        const store=this.available(),content=this.content;if(!content)return;
        let update=this.contract.read<Update>('update',store.feedback('update',updateId));
        if(update.status==='cancelled'||['committed','partially_committed','failed'].includes(update.status))return;
        await this.queue.run(()=>store.transaction(()=>{const current=this.contract.read<Update>('update',store.feedback('update',updateId));if(current.status==='queued')store.saveFeedback('update',updateId,this.contract.read<Json>('json',{...current,status:'planning'}));}));
        update=this.contract.read<Update>('update',store.feedback('update',updateId));
        const allAgreements=update.itemIds.map(id=>store.feedback('agreement',id)).filter((x):x is Json=>x!==undefined).map(x=>this.contract.read<Agreement>('agreement',x));
        const {agreements,blocked}=await this.judgeUpdateConflicts(update,allAgreements);
        const comments=allAgreements.map(a=>this.contract.read<FeedbackComment>('feedback-comment',store.feedback('comment',a.commentId)));
        const elements=store.elements(update.artifactId,update.baseVersion), direct:import('../../contract/src/index.js').CommitInput['changes']=[], results:Update['itemResults']=[...blocked], remaining:Agreement[]=[];
        for(const agreement of agreements){const comment=comments.find(c=>c.commentId===agreement.commentId)!,anchor=comment.anchor,element=anchor?elements.find(e=>e.elementId===anchor.elementId):undefined,quote=anchor?.locator?.quote,replacement=comment.suggestion?.replacement;
            if(anchor){const rawHold=store.feedback('hold',`${update.artifactId}:${anchor.elementId}`);if(rawHold&&this.activeHold(rawHold)){results.push({itemId:agreement.agreementId,status:'not_addressed',reason:'Element is held for direct editing.'});continue;}}
            if(!element||!('text'in element)||!quote||replacement===undefined){remaining.push(agreement);continue;}
            const existingIndex=direct.findIndex(change=>change.op==='update'&&change.elementId===element.elementId),prior=existingIndex<0?undefined:direct[existingIndex],currentText=prior?.op==='update'&&'text'in prior.element?prior.element.text:element.text;
            const at=findVerbatimQuote(currentText,quote,anchor.locator?.prefix,anchor.locator?.suffix);if(at===undefined){remaining.push(agreement);continue;}
            const draft=this.contract.read<import('../../contract/src/index.js').ElementDraft>('element-draft',{type:element.type,props:element.props,text:currentText.slice(0,at)+replacement+currentText.slice(at+quote.length)});
            if(existingIndex<0)direct.push({op:'update',elementId:element.elementId,element:draft});else direct[existingIndex]={op:'update',elementId:element.elementId,element:draft};results.push({itemId:agreement.agreementId,status:'addressed',elementIds:[element.elementId]});
        }
        try {
            if(remaining.length){
                const planned=update.plan&&update.status==='writing'?this.contract.read<import('../../contract/src/index.js').UpdatePlan>('update-plan',update.plan):await this.planUpdate(update,remaining,comments,elements,direct);
                if(!planned){await this.finishUpdate(update,allAgreements,[...results,...remaining.map(a=>({itemId:a.agreementId,status:'not_addressed' as const,reason:'No planner model is configured.'}))],direct,direct.length?update.baseVersion+1:undefined);return;}
                if(!update.plan){
                    const sessions=store.feedbackList('attachment').map(x=>this.contract.read<{sessionId:string;artifactId:string}>('session-artifact',x)).filter(x=>x.artifactId===update.artifactId).map(x=>x.sessionId);
                    const review=sessions.some(id=>this.settings().sessions[id]?.planReview===true);
                    if(review){await this.queue.run(()=>store.transaction(()=>{const current=this.contract.read<Update>('update',store.feedback('update',updateId));if(current.status!=='planning')return;store.saveFeedback('update',updateId,this.contract.read<Json>('json',{...current,plan:planned,status:'awaiting_plan_review',itemResults:results}));}));return;}
                }
                update=this.contract.read<Update>('update',store.feedback('update',updateId));
                await this.runUpdateWriter(update,remaining,allAgreements,comments,elements,direct,results,planned);
            }else await this.finishUpdate(update,allAgreements,results,direct,direct.length?update.baseVersion+1:undefined);
        } catch (error) {
            const reason=errorOf(error).message;
            await this.finishUpdate(update,allAgreements,[...results,...remaining.map(a=>({itemId:a.agreementId,status:'not_addressed' as const,reason}))],direct,direct.length?update.baseVersion+1:undefined);
        }
    }
    private async judgeUpdateConflicts(update:Update,agreements:Agreement[]):Promise<{agreements:Agreement[];blocked:Update['itemResults']}> {
        const store=this.available(),conflicts=store.feedbackList('conflict').map(x=>this.contract.read<FeedbackConflict>('feedback-conflict',x)).filter(x=>x.state==='open'&&x.artifactId===update.artifactId&&x.itemIds.some(id=>update.itemIds.includes(id)));
        const blocked:Update['itemResults']=[],eligible=new Set(agreements.map(a=>a.agreementId)),alias=this.settings().models.judge?'judge':undefined;
        for(const conflict of conflicts){
            const pair=conflict.itemIds.map(id=>agreements.find(a=>a.agreementId===id)).filter((x):x is Agreement=>x!==undefined);if(pair.length<2)continue;
            let verdict:'compatible'|'conflicting'|'unclear'='unclear',reason='No conflict judge model is configured.';
            if(alias){const messages:GatewayRequest['messages']=[{role:'user',content:JSON.stringify(pair.map(a=>({instruction:a.instruction,comment:store.feedback('comment',a.commentId)})))}];const output=await this.modelJson(alias,'conflict-judgement',update,messages,'judge');if(output){const judged=this.contract.read<import('../../contract/src/index.js').ConflictJudgement>('conflict-judgement',output);verdict=judged.verdict;reason=judged.reason;}}
            if(verdict==='compatible')await this.queue.run(()=>store.transaction(()=>{const current=this.contract.read<FeedbackConflict>('feedback-conflict',store.feedback('conflict',conflict.conflictId));store.saveFeedback('conflict',conflict.conflictId,this.contract.read<Json>('feedback-conflict',{...current,state:'resolved',judgement:{verdict,reason,judgedAt:this.deps.clock.now()}}));}));
            else for(const agreement of pair){eligible.delete(agreement.agreementId);blocked.push({itemId:agreement.agreementId,status:'not_addressed',reason:`Conflict remains ${verdict}: ${reason}`});}
        }
        return {agreements:agreements.filter(a=>eligible.has(a.agreementId)),blocked};
    }
    private async modelJson(alias: string, schemaName: string, update: Update, messages: GatewayRequest['messages'], promptName: string): Promise<Json|undefined> {
        const settings=this.settings(), model=this.gateway&&settings.models[alias]; if(!model||!this.gateway)return undefined;
        const prompt=await readFile(new URL(`./agent/prompts/${promptName}.md`,import.meta.url),'utf8'),promptHash=createHash('sha256').update(prompt).digest('hex');
        const sessionSettings=settings.sessions[this.updateSessionId(update)],tokenLimit=sessionSettings?.tokenLimit??settings.budgets.defaultTurnTokenLimit??8192;
        const request:GatewayRequest={modelRef:alias,messages:[{role:'system',content:prompt},...messages],output:{kind:'json',schema:this.contract.schema(schemaName),name:schemaName},maxOutputTokens:Math.min(3000,tokenLimit)};
        if(estimateInputTokens(request)+request.maxOutputTokens>tokenLimit)fail('budget_exceeded','Update context exceeds its configured token limit');
        const contextItems=messages.map((message,index)=>({kind:'retrieval' as const,id:`${schemaName}:${index}`,hash:createHash('sha256').update(message.content).digest('hex'),tokens:Math.ceil(message.content.length/3),reason:`${message.role} context`}));
        const manifestId=this.deps.ids.next('manifest_'),manifest=this.contract.read<ContextManifest>('context-manifest',{manifestId,turnId:update.updateId,requestIndex:storeRequestIndex(this.available(),update.updateId),items:[{kind:'system_prompt',id:`${promptName}.md`,hash:promptHash,tokens:Math.ceil(prompt.length/3),reason:'Update prompt'},...contextItems],dropped:[],promptHash,createdAt:this.deps.clock.now()});
        await this.queue.run(()=>this.available().transaction(()=>this.available().saveFeedback('manifest',manifestId,this.contract.read<Json>('json',manifest))));
        const reservationId=this.deps.ids.next('reservation_');this.budgets?.reserve(reservationId,[{kind:'turn',key:update.updateId},{kind:'session',key:this.updateSessionId(update)},{kind:'daily'}],estimateReservationMicros(request,model));
        let output:Json|undefined;
        for await(const event of this.gateway.call(request,{reservationId,idempotencyKey:`${update.updateId}:${promptName}:${manifest.requestIndex}`,signal:new AbortController().signal})){
            if(event.type==='output')output=this.contract.read<Json>(schemaName,event.json);
            if(event.type==='error')fail(event.code==='rate_limited'?'rate_limited':'unavailable',event.message);
        }
        return output;
    }
    private updateSessionId(update: Update): string {
        const store=this.available();for(const id of update.itemIds){const raw=store.feedback('agreement',id);if(raw){const agreement=this.contract.read<Agreement>('agreement',raw),comment=store.feedback('comment',agreement.commentId);if(comment)return this.contract.read<FeedbackComment>('feedback-comment',comment).sessionId;}}
        fail('not_found','Update has no session context');
    }
    private async planUpdate(update: Update, items: Agreement[], comments: FeedbackComment[], elements: import('../../contract/src/index.js').Element[], alreadyChanged: import('../../contract/src/index.js').CommitInput['changes']): Promise<import('../../contract/src/index.js').UpdatePlan|undefined> {
        const already=new Set(alreadyChanged.flatMap(c=>c.op==='add'?[]:[c.elementId]));
        for(const raw of this.available().feedbackList('hold'))if(this.activeHold(raw)){const hold=this.contract.read<{artifactId:string;elementId:string}>('hold',raw);if(hold.artifactId===update.artifactId)already.add(hold.elementId);}
        const known=new Set(elements.map(e=>e.elementId));
        const messages:GatewayRequest['messages']=[{role:'user',content:JSON.stringify({items:items.map(a=>({itemId:a.agreementId,instruction:a.instruction,comment:comments.find(c=>c.commentId===a.commentId)})),elements})}];
        const alias=this.settings().models.planner?'planner':'default';
        const output=await this.modelJson(alias,'update-plan',update,messages,'plan');if(output===undefined)return undefined;
        const plan=this.contract.read<import('../../contract/src/index.js').UpdatePlan>('update-plan',output),expected=new Set(items.map(x=>x.agreementId));
        if(plan.items.length!==expected.size||new Set(plan.items.map(x=>x.itemId)).size!==expected.size||plan.items.some(x=>!expected.has(x.itemId)))fail('invalid','Planner did not account for every Update item');
        for(const item of plan.items){if(item.elementIds.some(id=>!known.has(id)||already.has(id))||item.newUnder?.some(id=>!known.has(id)||already.has(id)))fail('invalid','Planner referenced an unknown, held, or already changed element');if(item.action==='none'&&(item.elementIds.length||item.newUnder?.length))fail('invalid','A no-op plan cannot declare a write set');if(item.action==='add'&&!item.newUnder?.length)fail('invalid','An add plan must name a permitted parent');if(['edit','move','remove'].includes(item.action)&&!item.elementIds.length)fail('invalid','A modifying plan must name existing elements');}
        return plan;
    }
    private async runUpdateWriter(update: Update, remaining: Agreement[], agreements: Agreement[], comments: FeedbackComment[], elements: import('../../contract/src/index.js').Element[], direct: import('../../contract/src/index.js').CommitInput['changes'], directResults: Update['itemResults'], providedPlan?: import('../../contract/src/index.js').UpdatePlan): Promise<void> {
        const plan=providedPlan??(update.plan?this.contract.read<import('../../contract/src/index.js').UpdatePlan>('update-plan',update.plan):undefined);if(!plan)fail('invalid','Update plan is missing');
        const aliases=this.settings().models,alias=aliases.writer?'writer':'default',expected=new Set(remaining.map(x=>x.agreementId));
        const planned=new Set(plan.items.flatMap(item=>item.elementIds)),newUnder=new Set(plan.items.flatMap(item=>item.newUnder??[]));
        const requestMessages:GatewayRequest['messages']=[{role:'user',content:JSON.stringify({items:remaining.map(a=>({itemId:a.agreementId,instruction:a.instruction,comment:comments.find(c=>c.commentId===a.commentId)})),plan,elements})}];
        let write:import('../../contract/src/index.js').UpdateWrite|undefined,validationError='';
        for(let attempt=0;attempt<2;attempt++){
            const output=await this.modelJson(alias,'update-write',update,[...requestMessages,...(validationError?[{role:'user' as const,content:`Previous output rejected: ${validationError}`}]:[])],'write');if(output===undefined)break;
            try{
                const candidate=this.contract.read<import('../../contract/src/index.js').UpdateWrite>('update-write',output),changes=candidate.changes,changedIds=new Set<string>();
                for(const change of changes){if(change.op==='add'){if(change.parentId!==null&&!newUnder.has(change.parentId))fail('invalid','Writer added outside the permitted new-child scope');if(!plan.items.some(item=>item.action==='add'&&item.newUnder?.includes(change.parentId??'')))fail('invalid','Writer added without a matching add plan');if(changedIds.has(change.tempId))fail('invalid','Writer reused a temporary id');changedIds.add(change.tempId);}else{if(!planned.has(change.elementId))fail('invalid','Writer changed outside the planned write set');const permitted=plan.items.some(item=>item.elementIds.includes(change.elementId)&&(change.op==='update'?item.action==='edit':change.op==='move'?item.action==='move':item.action==='remove'));if(!permitted)fail('invalid','Writer action does not match the reviewed plan');if(changedIds.has(change.elementId))fail('invalid','Writer changed an element more than once');changedIds.add(change.elementId);}}
                if(candidate.itemResults.length!==expected.size||new Set(candidate.itemResults.map(x=>x.itemId)).size!==expected.size||candidate.itemResults.some(x=>!expected.has(x.itemId)))fail('invalid','Writer did not account for every agreed item');
                for(const result of candidate.itemResults)if(result.status==='addressed'&&result.elementIds.some(id=>!changedIds.has(id)))fail('invalid','Writer marked an unchanged element as addressed');
                write=candidate;break;
            }catch(error){validationError=errorOf(error).message;}
        }
        const modelResults=write?.itemResults??remaining.map(a=>({itemId:a.agreementId,status:'not_addressed' as const,reason:validationError||'Writer did not return a valid result.'}));
        await this.finishUpdate(update,agreements,[...directResults,...modelResults],write?[...direct,...write.changes]:direct,write&&[...direct,...write.changes].length?update.baseVersion+1:undefined);
    }
    private async finishUpdate(update: Update, agreements: Agreement[], results: Update['itemResults'], changes: import('../../contract/src/index.js').CommitInput['changes'], expectedVersion?: number): Promise<void> {
        await this.queue.run(()=>this.available().transaction(()=>{
            const store=this.available(),content=this.content;if(!content)fail('unavailable','Content engine is stopped');
            const current=this.contract.read<Update>('update',store.feedback('update',update.updateId));if(!['queued','planning','writing','checking'].includes(current.status))return;
            let resultVersion:number|undefined,idMap:Record<string,string>={};
            const base=store.version(update.artifactId,update.baseVersion),head=store.version(update.artifactId),staleIds=new Set<string>(),staleTemps=new Set<string>();
            const baseElements=store.elements(update.artifactId,update.baseVersion),children=new Map<string,string[]>();for(const element of baseElements)if(element.parentId){const ids=children.get(element.parentId)??[];ids.push(element.elementId);children.set(element.parentId,ids);}
            const descendants=(id:string):string[]=>[id,...(children.get(id)??[]).flatMap(descendants)];
            const safeChanges=changes.filter(change=>{
                if(change.op==='add'){if(change.parentId!==null&&!head.manifest[change.parentId]){staleTemps.add(change.tempId);return false;}return true;}
                const targets=change.op==='remove'?descendants(change.elementId):[change.elementId],stale=targets.filter(id=>head.manifest[id]!==base.manifest[id]);
                if(stale.length){for(const id of stale)staleIds.add(id);staleIds.add(change.elementId);return false;}return true;
            });
            if(safeChanges.length){const committed=content.commit({artifactId:update.artifactId,baseVersion:update.baseVersion,changes:safeChanges,createdBy:{kind:'system',job:'agent.update'},source:{updateId:update.updateId}});resultVersion=committed.version;idMap=committed.idMap;if(expectedVersion!==undefined&&expectedVersion!==resultVersion)fail('internal','Update committed an unexpected version');}
            const normalized=results.map(result=>result.status==='addressed'&&result.elementIds?(()=>{const stale=result.elementIds.some(id=>staleIds.has(id)||staleTemps.has(id));return stale?{itemId:result.itemId,status:'not_addressed' as const,reason:'A direct edit changed part of this item while the Update was running.'}:{...result,elementIds:result.elementIds.map(id=>idMap[id]??id)};})():result);
            for(const agreement of agreements){const result=normalized.find(x=>x.itemId===agreement.agreementId);if(result?.status==='addressed'&&resultVersion){store.saveFeedback('agreement',agreement.agreementId,this.contract.read<Json>('agreement',{...agreement,state:'applied',appliedVersion:resultVersion}));const raw=store.feedback('comment',agreement.commentId);if(raw){const comment=this.contract.read<FeedbackComment>('feedback-comment',raw);store.saveFeedback('comment',comment.commentId,this.contract.read<Json>('feedback-comment',{...comment,state:'applied',appliedInVersion:resultVersion,updatedAt:this.deps.clock.now()}));store.saveFeedback('delivery-state',comment.commentId,this.contract.read<Json>('delivery-state',{commentId:comment.commentId,state:'handled',updatedAt:this.deps.clock.now()}));this.feedback?.systemNotice(comment.sessionId,comment.threadId,`Agreed item applied in version ${resultVersion}.`);}}else store.saveFeedback('agreement',agreement.agreementId,this.contract.read<Json>('agreement',{...agreement,state:'agreed'}));}
            const status:Update['status']=resultVersion?(normalized.some(x=>x.status==='not_addressed')?'partially_committed':'committed'):'failed';
            store.saveFeedback('update',update.updateId,this.contract.read<Json>('json',{...current,status,...(resultVersion?{resultVersion}:{}),itemResults:normalized}));
        }));
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
function findVerbatimQuote(text: string, quote: string, prefix?: string, suffix?: string): number | undefined {
    const positions: number[] = [];
    for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) positions.push(at);
    if (prefix !== undefined || suffix !== undefined) {
        const contextual = positions.filter(at => (prefix === undefined || text.slice(Math.max(0, at - prefix.length), at) === prefix) && (suffix === undefined || text.slice(at + quote.length, at + quote.length + suffix.length) === suffix));
        if (contextual.length === 1) return contextual[0];
    }
    return positions.length === 1 ? positions[0] : undefined;
}
function storeRequestIndex(store: import('./storage/repository.js').Repository, turnId: string): number {
    return store.feedbackList('manifest').filter(value => typeof value === 'object' && value !== null && !Array.isArray(value) && Reflect.get(value, 'turnId') === turnId).length;
}
