import { expect, it } from 'vitest';
import { Contract } from '../../contract/src/index.js';
import type { Json } from '../../contract/src/index.js';
import { ScriptedProvider } from '../src/gateway/fake.js';
import type { ProviderModel } from '../src/gateway/types.js';
import { ctx, fixture } from './helpers.js';

const model: ProviderModel = { provider: 'openai-compatible', baseUrl: 'https://model.example.test/v1', model: 'fake-model', capabilities: { tools: true, jsonSchemaOutput: true, streaming: true, maxContextTokens: 8192, reportsUsage: true }, pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 } };
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
    for (let i = 0; i < 100; i++) { const value = await read(); if (ready(value)) return value; await new Promise<void>(resolve => setTimeout(resolve, 10)); }
    throw Error('Agent turn did not complete');
}
it('runs a manual reply through validated tools, records exact manifests and delivery states, and leaves versions untouched', async () => {
    const provider = new ScriptedProvider();
    const f = await fixture({ modelProviders: { 'openai-compatible': provider } });
    try {
        await f.engine.command(ctx, { commandId: 'model-settings', type: 'sys.SetSettings', payload: new Contract().read<Json>('json', { patch: { models: { default: model }, budgets: { defaultTurnLimitMicros: 100_000, toolCallLimit: 12 }, sessions: {} } }) });
        const artifactResult = await f.engine.command(ctx, { commandId: 'artifact', type: 'vc.ImportContent', payload: { content: 'A draft sentence.', format: 'text', title: 'Draft' } });
        if (!artifactResult.ok) throw Error(artifactResult.error.message);
        const artifactId = new Contract().read<{ artifactId: string }>('operations/vc.ImportContent', artifactResult.result, '#/properties/result').artifactId;
        const projectResult = await f.engine.command(ctx, { commandId: 'project', type: 'vc.CreateProject', payload: { title: 'Project' } });
        if (!projectResult.ok) throw Error(projectResult.error.message);
        const projectId = new Contract().read<{ projectId: string }>('operations/vc.CreateProject', projectResult.result, '#/properties/result').projectId;
        const sessionResult = await f.engine.command(ctx, { commandId: 'session', type: 'vc.StartSession', payload: { title: 'Review', primaryProjectId: projectId, replyTrigger: 'manual' } });
        if (!sessionResult.ok) throw Error(sessionResult.error.message);
        const sessionId = new Contract().read<{ sessionId: string }>('operations/vc.StartSession', sessionResult.result, '#/properties/result').sessionId;
        await f.engine.command(ctx, { commandId: 'attach', type: 'vc.AttachArtifact', payload: { sessionId, artifactId, role: 'primary' } });
        const comment = await f.engine.command(ctx, { commandId: 'comment', type: 'vc.Comment', payload: { sessionId, body: 'Please improve this sentence.' } });
        if (!comment.ok) throw Error(comment.error.message);
        const commentId = new Contract().read<{ commentId: string; threadId: string }>('operations/vc.Comment', comment.result, '#/properties/result');
        provider.enqueueDefaultSequence([
            [{ type: 'tool_call', call: { id: 'call-search', name: 'search', arguments: { query: 'sentence' } } }, { type: 'tool_call', call: { id: 'call-1', name: 'reply', arguments: { threadId: commentId.threadId, body: 'I can tighten that sentence.' } } }, { type: 'usage', inputTokens: 80, outputTokens: 10, quality: 'reported' }, { type: 'done', finishReason: 'tool_calls' }],
            [{ type: 'text_delta', text: 'I replied in the thread.' }, { type: 'usage', inputTokens: 90, outputTokens: 8, quality: 'reported' }, { type: 'done', finishReason: 'stop' }]
        ]);
        const queued = await f.engine.command(ctx, { commandId: 'ask', type: 'vc.AskAgent', payload: { sessionId, threadIds: [commentId.threadId] } });
        expect(queued.ok).toBe(true);
        if (!queued.ok) throw Error(queued.error.message);
        const turnId = new Contract().read<{ turnId: string }>('operations/vc.AskAgent', queued.result, '#/properties/result').turnId;
        const turns = await waitFor(() => f.engine.query(ctx, { name: 'vc.AgentTurns', args: { sessionId } }), value => new Contract().read<import('../../contract/src/index.js').AgentTurn[]>('operations/vc.AgentTurns', value, '#/properties/result').some(turn => turn.turnId === turnId && turn.status === 'completed'));
        expect(new Contract().read<import('../../contract/src/index.js').AgentTurn[]>('operations/vc.AgentTurns', turns, '#/properties/result')).toMatchObject([{ turnId, status: 'completed' }]);
        expect(provider.calls).toHaveLength(2);
        expect(provider.calls[1]!.request.messages.some(message => message.role === 'tool' && message.content.includes('A draft sentence.'))).toBe(true);
        const manifestResult = await f.engine.query(ctx, { name: 'vc.Manifest', args: { turnId } });
        const manifests = new Contract().read<import('../../contract/src/index.js').ContextManifest[]>('operations/vc.Manifest', manifestResult, '#/properties/result');
        expect(manifests).toHaveLength(2);
        expect(manifests[0]!.items.some(item => item.kind === 'comment' && item.id === commentId.commentId)).toBe(true);
        expect(manifests[0]!.promptHash).toMatch(/^[a-f0-9]{64}$/);
        const delivery = await f.engine.query(ctx, { name: 'vc.DeliveryState', args: { commentIds: [commentId.commentId] } });
        expect(delivery).toMatchObject([{ commentId: commentId.commentId, state: 'replied', turnId }]);
        const threads = new Contract().read<import('../../contract/src/index.js').Thread[]>('operations/vc.Threads', await f.engine.query(ctx, { name: 'vc.Threads', args: { sessionId } }), '#/properties/result');
        expect(threads[0]!.comments.some(c => c.author.kind === 'agent' && c.replyTo === commentId.commentId)).toBe(true);
        expect(await f.engine.query(ctx, { name: 'vc.Versions', args: { artifactId } })).toHaveLength(1);
    }
    finally { await f.close(); }
});

it('does not accept adapter supplied agent principals and allows only human grant management', async () => {
    const f = await fixture();
    try {
        const grant = await f.engine.command(ctx, { commandId: 'grant', type: 'vc.CreateGrant', payload: { scope: { sessionIds: ['s'] }, capabilities: ['auto_agree_own_proposals'], limits: { spendMicros: 1000 } } });
        expect(grant.ok).toBe(true);
        const system = await f.engine.command({ ...ctx, principal: { kind: 'system', job: 'agent.reply' } }, { commandId: 'system-grant', type: 'vc.CreateGrant', payload: { scope: {}, capabilities: ['start_review'], limits: {} } });
        expect(system).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await f.engine.query(ctx, { name: 'vc.Grants', args: {} })).toHaveLength(1);
    }
    finally { await f.close(); }
});

it('debounces realtime comments and includes all comments received before dispatch', async () => {
    let now = Date.parse('2026-10-28T00:00:00.000Z');
    const f = await fixture({ clock: { now: () => new Date(now).toISOString() } });
    try {
        const projectResult = await f.engine.command(ctx, { commandId: 'debounce-project', type: 'vc.CreateProject', payload: { title: 'Project' } });
        if (!projectResult.ok) throw Error(projectResult.error.message);
        const { projectId } = new Contract().read<{projectId:string}>('operations/vc.CreateProject', projectResult.result, '#/properties/result');
        const sessionResult = await f.engine.command(ctx, { commandId: 'debounce-session', type: 'vc.StartSession', payload: { title: 'Realtime', primaryProjectId: projectId, replyTrigger: 'realtime' } });
        if (!sessionResult.ok) throw Error(sessionResult.error.message);
        const { sessionId } = new Contract().read<{sessionId:string}>('operations/vc.StartSession', sessionResult.result, '#/properties/result');
        await f.engine.command(ctx, { commandId: 'debounce-comment-1', type: 'vc.Comment', payload: { sessionId, body: 'First comment.' } });
        now += 1000;
        await f.engine.command(ctx, { commandId: 'debounce-comment-2', type: 'vc.Comment', payload: { sessionId, body: 'Second comment.' } });
        now += 8000;
        const comments = new Contract().read<import('../../contract/src/index.js').Thread[]>('operations/vc.Threads', await f.engine.query(ctx, { name: 'vc.Threads', args: { sessionId } }), '#/properties/result').flatMap(thread => thread.comments.map(comment => comment.commentId));
        const result = await waitFor(() => f.engine.query(ctx, { name: 'vc.AgentTurns', args: { sessionId } }), value => new Contract().read<import('../../contract/src/index.js').AgentTurn[]>('operations/vc.AgentTurns', value, '#/properties/result').length === 1);
        const [turn] = new Contract().read<import('../../contract/src/index.js').AgentTurn[]>('operations/vc.AgentTurns', result, '#/properties/result');
        expect(turn!.trigger).toMatchObject({ mode: 'realtime', commentIds: expect.arrayContaining(comments) });
    } finally { await f.close(); }
});

it('queues a batch reply when the configured comment threshold is reached', async () => {
    const f = await fixture();
    try {
        const project = await f.engine.command(ctx, { commandId: 'batch-project', type: 'vc.CreateProject', payload: { title: 'Project' } });
        if (!project.ok) throw Error(project.error.message);
        const { projectId } = new Contract().read<{projectId:string}>('operations/vc.CreateProject', project.result, '#/properties/result');
        const session = await f.engine.command(ctx, { commandId: 'batch-session', type: 'vc.StartSession', payload: { title: 'Batch', primaryProjectId: projectId, replyTrigger: 'batch' } });
        if (!session.ok) throw Error(session.error.message);
        const { sessionId } = new Contract().read<{sessionId:string}>('operations/vc.StartSession', session.result, '#/properties/result');
        for (let n = 0; n < 5; n++) await f.engine.command(ctx, { commandId: 'batch-comment-' + n, type: 'vc.Comment', payload: { sessionId, body: 'Comment ' + n } });
        const result = await waitFor(() => f.engine.query(ctx, { name: 'vc.AgentTurns', args: { sessionId } }), value => new Contract().read<import('../../contract/src/index.js').AgentTurn[]>('operations/vc.AgentTurns', value, '#/properties/result').length === 1);
        const [turn] = new Contract().read<import('../../contract/src/index.js').AgentTurn[]>('operations/vc.AgentTurns', result, '#/properties/result');
        expect(turn!.trigger).toMatchObject({ mode: 'batch', commentIds: expect.any(Array) });
        expect(turn!.trigger.commentIds).toHaveLength(5);
    } finally { await f.close(); }
});
