import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, open, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { Contract, CONTRACT_VERSION, errorOf, fail } from '../../../contract/src/index.js';
import type { CallContext, CommandEnvelope, CommandResult, ContractError, EventEnvelope, Json, QueryEnvelope, Subscription } from '../../../contract/src/index.js';
import type { Engine } from '../../../engine/src/engine.js';
export interface Tokens {
    read: string;
    collaborate: string;
    admin: string;
}
export interface HttpOptions {
    workspaceDir: string;
    port?: number;
    host?: string;
    appOrigin?: string;
    tokenFactory?: () => string;
}
const statuses: Record<ContractError['code'], number> = { invalid: 400, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409, stale_base: 409, locked: 423, budget_exceeded: 402, rate_limited: 429, unsupported: 501, unavailable: 503, uncertain: 503, internal: 500 };
function isTokens(value: unknown): value is Tokens { return typeof value === 'object' && value !== null && 'read' in value && typeof value.read === 'string' && 'collaborate' in value && typeof value.collaborate === 'string' && 'admin' in value && typeof value.admin === 'string' && new Set([value.read, value.collaborate, value.admin]).size === 3 && [value.read, value.collaborate, value.admin].every(s => s.length >= 16); }
async function tokensAt(dir: string, factory = () => randomBytes(32).toString('hex')): Promise<Tokens> {
    const path = join(dir, 'access-tokens.json');
    try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isTokens(parsed))
            fail('unavailable', 'Token store is invalid');
        await chmod(path, 0o600);
        return parsed;
    }
    catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'))
            throw error;
    }
    const tokens = { read: factory(), collaborate: factory(), admin: factory() };
    if (!isTokens(tokens))
        fail('invalid', 'Token factory produced invalid credentials');
    const file = await open(path, 'wx', 0o600);
    try {
        await file.writeFile(JSON.stringify(tokens));
        await file.sync();
    }
    finally {
        await file.close();
    }
    return tokens;
}
async function body(req: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; let size = 0; for await (const part of req) {
    const chunk: unknown = part;
    if (!Buffer.isBuffer(chunk))
        fail('invalid', 'Invalid request body');
    size += chunk.length;
    if (size > 16 * 1024 * 1024)
        fail('invalid', 'Request body exceeds 16 MiB');
    chunks.push(chunk);
} return Buffer.concat(chunks); }
function parseJson(bytes: Buffer): unknown { try {
    return JSON.parse(bytes.toString('utf8'));
}
catch {
    fail('invalid', 'Invalid JSON');
} }
function send(res: ServerResponse, status: number, value: unknown) { if (res.destroyed || res.headersSent)
    return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
export async function startHttp(engine: Engine, options: HttpOptions) {
    if (options.host !== undefined && options.host !== '127.0.0.1')
        fail('invalid', 'HTTP must bind to 127.0.0.1');
    const tokens = await tokensAt(options.workspaceDir, options.tokenFactory), contract = new Contract();
    let port = 0, requestNumber = 0;
    const streams = new Set<AsyncIterator<EventEnvelope>>();
    const server = createServer((req, res) => { void handle(req, res).catch(error => { const e = errorOf(error); send(res, statuses[e.code], e); }); });
    async function handle(req: IncomingMessage, res: ServerResponse) {
        if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host ?? ''))
            fail('forbidden', 'Invalid Host');
        if (req.headers.origin !== undefined && req.headers.origin !== options.appOrigin)
            fail('forbidden', 'Origin is not permitted');
        const auth = req.headers.authorization;
        if (!auth?.startsWith('Bearer '))
            fail('unauthenticated', 'Access token required');
        const supplied = Buffer.from(auth.slice(7));
        let scope: CallContext['scope'] | undefined;
        for (const name of ['read', 'collaborate', 'admin'] satisfies CallContext['scope'][]) {
            const secret = Buffer.from(tokens[name]);
            if (secret.length === supplied.length && timingSafeEqual(secret, supplied))
                scope = name;
        }
        if (!scope)
            fail('unauthenticated', 'Invalid access token');
        const ctx: CallContext = { contractVersion: req.headers['x-contract-version']?.toString() ?? CONTRACT_VERSION, principal: { kind: 'human' }, channel: 'http', scope, requestId: 'http-' + (++requestNumber) };
        const url = new URL(req.url ?? '/', 'http://127.0.0.1:' + port), path = url.pathname;
        if (req.method === 'GET' && path === '/v1/capabilities') {
            send(res, 200, await engine.query(ctx, { name: 'sys.Capabilities', args: {} }));
            return;
        }
        if (req.method === 'POST' && path.startsWith('/v1/commands/')) {
            const type = decodeURIComponent(path.slice('/v1/commands/'.length)), input = parseJson(await body(req));
            if (!input || typeof input !== 'object' || Array.isArray(input))
                fail('invalid', 'Invalid command body');
            const cmd = contract.read<CommandEnvelope>('command-envelope', { ...input, type });
            const result = await engine.command(ctx, cmd);
            if (result.ok)
                send(res, 200, result);
            else
                send(res, statuses[result.error.code], result.error);
            return;
        }
        if (req.method === 'POST' && path.startsWith('/v1/queries/')) {
            const name = decodeURIComponent(path.slice('/v1/queries/'.length)), input = parseJson(await body(req));
            if (!input || typeof input !== 'object' || Array.isArray(input))
                fail('invalid', 'Invalid query body');
            const q = contract.read<QueryEnvelope>('query-envelope', { ...input, name });
            send(res, 200, await engine.query(ctx, q));
            return;
        }
        if (req.method === 'GET' && path === '/v1/events') {
            const raw = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
            if (typeof raw !== 'string' || !/^\d+$/.test(raw))
                fail('invalid', 'Invalid event cursor');
            const filter = url.searchParams.get('filter');
            const subscription = contract.read<Subscription>('subscription', { afterSeq: Number(raw), ...(filter === null ? {} : { filter: parseJson(Buffer.from(filter)) }) }), iterator = engine.subscribe(ctx, subscription)[Symbol.asyncIterator]();
            streams.add(iterator);
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            res.flushHeaders();
            res.on('close', () => { streams.delete(iterator); void iterator.return?.(); });
            try {
                while (!res.destroyed) {
                    const next = await iterator.next();
                    if (next.done)
                        break;
                    if (!res.write('id: ' + next.value.seq + '\nevent: ' + next.value.type + '\ndata: ' + JSON.stringify(next.value) + '\n\n'))
                        await new Promise<void>(resolve => { res.once('drain', resolve); res.once('close', resolve); });
                }
            }
            finally {
                streams.delete(iterator);
                await iterator.return?.();
                res.end();
            }
            return;
        }
        if (path.startsWith('/v1/blobs/')) {
            const hash = path.slice('/v1/blobs/'.length);
            if (!/^[a-f0-9]{64}$/.test(hash))
                fail('invalid', 'Invalid blob hash');
            if (req.method === 'PUT') {
                const bytes = await body(req);
                if (createHash('sha256').update(bytes).digest('hex') !== hash)
                    fail('invalid', 'Blob hash does not match content');
                const stored = await engine.putBlob(ctx, bytes, req.headers['content-type'] ?? 'application/octet-stream');
                send(res, 200, { hash: stored });
                return;
            }
            if (req.method === 'GET') {
                const bytes = await engine.getBlob(ctx, hash);
                res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
                res.end(bytes);
                return;
            }
        }
        fail('not_found', 'Route not found');
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw Error('Missing server address');
    port = address.port;
    return { url: 'http://127.0.0.1:' + port, tokens, close: async () => { for (const stream of streams)
            await stream.return?.(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
// This client mechanically maps the same contract and is used by the shared conformance suite.
export function httpClient(base: string, tokens: Tokens) {
    const contract = new Contract();
    const headers = (ctx: CallContext) => ({ Authorization: 'Bearer ' + tokens[ctx.scope], 'X-Contract-Version': ctx.contractVersion });
    async function json(ctx: CallContext, path: string, body?: unknown): Promise<unknown> { const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers(ctx), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value: unknown = await res.json(); if (!res.ok) {
        const e = contract.read<ContractError>('contract-error', value);
        fail(e.code, e.message, e.details);
    } return value; }
    return {
        async command(ctx: CallContext, cmd: CommandEnvelope): Promise<CommandResult> { try {
            return contract.read<CommandResult>('command-result', await json(ctx, '/v1/commands/' + encodeURIComponent(cmd.type), { commandId: cmd.commandId, payload: cmd.payload }));
        }
        catch (error) {
            return { ok: false, error: errorOf(error) };
        } },
        async query(ctx: CallContext, q: QueryEnvelope): Promise<Json> { return contract.read<Json>('operations/' + q.name, await json(ctx, '/v1/queries/' + encodeURIComponent(q.name), { args: q.args }), '#/properties/result'); },
        subscribe(ctx: CallContext, sub: Subscription): AsyncIterable<EventEnvelope> {
            const abort = new AbortController();
            let iterator: AsyncIterator<EventEnvelope> | undefined;
            async function* events() {
                // Send Last-Event-ID on reconnect; the server must give it precedence over the query cursor.
                const res = await fetch(base + '/v1/events?after=0' + (sub.filter ? '&filter=' + encodeURIComponent(JSON.stringify(sub.filter)) : ''), { headers: { ...headers(ctx), 'Last-Event-ID': String(sub.afterSeq) }, signal: abort.signal });
                if (!res.ok) {
                    const e = contract.read<ContractError>('contract-error', await res.json());
                    fail(e.code, e.message, e.details);
                }
                if (!res.body)
                    fail('unavailable', 'Event stream is unavailable');
                const reader = res.body.getReader(), decoder = new TextDecoder();
                let buffer = '';
                try {
                    while (true) {
                        const part = await reader.read();
                        if (part.done)
                            return;
                        buffer += decoder.decode(part.value, { stream: true });
                        let at: number;
                        while ((at = buffer.indexOf('\n\n')) >= 0) {
                            const frame = buffer.slice(0, at);
                            buffer = buffer.slice(at + 2);
                            const data = frame.split('\n').find(line => line.startsWith('data: '));
                            if (data)
                                yield contract.read<EventEnvelope>('event-envelope', JSON.parse(data.slice(6)));
                        }
                    }
                }
                finally {
                    await reader.cancel().catch(() => undefined);
                    reader.releaseLock();
                }
            }
            return { [Symbol.asyncIterator]() { iterator = events(); return { next: () => iterator!.next(), return: async () => { abort.abort(); return iterator!.return ? await iterator!.return() : { done: true, value: undefined }; } }; } };
        },
        async putBlob(ctx: CallContext, bytes: Uint8Array, mediaType: string): Promise<string> { const hash = createHash('sha256').update(bytes).digest('hex'); const res = await fetch(base + '/v1/blobs/' + hash, { method: 'PUT', headers: { ...headers(ctx), 'Content-Type': mediaType }, body: Buffer.from(bytes) }); if (!res.ok) {
            const e = contract.read<ContractError>('contract-error', await res.json());
            fail(e.code, e.message, e.details);
        } return hash; },
        async getBlob(ctx: CallContext, hash: string): Promise<Uint8Array> { const res = await fetch(base + '/v1/blobs/' + hash, { headers: headers(ctx) }); if (!res.ok) {
            const e = contract.read<ContractError>('contract-error', await res.json());
            fail(e.code, e.message, e.details);
        } return new Uint8Array(await res.arrayBuffer()); }
    };
}
