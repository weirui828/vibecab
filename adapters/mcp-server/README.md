# VibeCab MCP server

Build the workspace with `pnpm build`, then configure an MCP client to launch `adapters/mcp-server/bin/vibecab-mcp.mjs` over stdio. Set `VIBECAB_WORKSPACE` to the workspace directory and `VIBECAB_MCP_TOKEN` to a VibeCab token created for the `mcp` channel. Token scope is resolved by the engine; the adapter never chooses it.

The optional `startMcpHttp(engine, { port })` host helper binds only to `127.0.0.1` and serves Streamable HTTP at `/mcp`. Send the MCP token as a bearer credential. It applies the same Host and Origin checks as the HTTP API adapter.

Tools are generated from the operation catalog and `contract/mcp-tools.json`. Read tokens receive query tools; collaborate tokens also receive collaborate commands. Resources include artifact versions and collaboration threads. Admin operations are excluded by channel metadata and remain rejected by the engine if called directly.
