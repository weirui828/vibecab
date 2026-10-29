import { contractSuite } from './suite.js';
import { fixture, tokenFactory } from '../helpers.js';
import { inProcess } from '../../../adapters/in-process/src/index.js';
import { startHttp, httpClient } from '../../../adapters/http/src/index.js';
contractSuite('in-process', async () => {
    const f = await fixture();
    const adapter = (ctx: import('../../../contract/src/index.js').CallContext) => inProcess(f.engine, { scope: ctx.scope, contractVersion: ctx.contractVersion });
    const client: import('./suite.js').Client = {
        command: (ctx, cmd) => adapter(ctx).command(cmd), query: (ctx, q) => adapter(ctx).query(q), subscribe: (ctx, sub) => adapter(ctx).subscribe(sub),
        putBlob: (ctx, bytes, type) => adapter(ctx).putBlob(bytes, type), getBlob: (ctx, hash) => adapter(ctx).getBlob(hash)
    };
    return { client, close: f.close };
});
contractSuite('HTTP', async () => { const f = await fixture(); const server = await startHttp(f.engine, { workspaceDir: f.dir, tokenFactory: tokenFactory() }); return { client: httpClient(server.url, server.tokens), close: async () => { await server.close(); await f.close(); } }; });
