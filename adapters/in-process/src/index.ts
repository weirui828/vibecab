import { CONTRACT_VERSION } from '../../../contract/src/index.js';
import type { CallContext, CommandEnvelope, QueryEnvelope, Subscription } from '../../../contract/src/index.js';
import type { Engine } from '../../../engine/src/engine.js';
export interface InProcessClient {
    command(cmd:CommandEnvelope):ReturnType<Engine['command']>;
    query(query:QueryEnvelope):ReturnType<Engine['query']>;
    subscribe(sub:Subscription):ReturnType<Engine['subscribe']>;
    putBlob(bytes:Uint8Array,mediaType:string):ReturnType<Engine['putBlob']>;
    getBlob(hash:string):ReturnType<Engine['getBlob']>;
}
export function inProcess(engine: Engine, options: {
    scope?: CallContext['scope'];
    contractVersion?: string;
} = {}): InProcessClient {
    let n = 0;
    const context = (): CallContext => ({ contractVersion: options.contractVersion ?? CONTRACT_VERSION, principal: { kind: 'human' }, channel: 'in_process', scope: options.scope ?? 'admin', requestId: 'in-process-' + (++n) });
    return {
        command: (cmd: CommandEnvelope) => engine.command(context(), cmd),
        query: (query: QueryEnvelope) => engine.query(context(), query),
        subscribe: (sub: Subscription) => engine.subscribe(context(), sub),
        putBlob: (bytes: Uint8Array, mediaType: string) => engine.putBlob(context(), bytes, mediaType),
        getBlob: (hash: string) => engine.getBlob(context(), hash)
    };
}
