# VibeCab MCP client adapter

Implements the engine's `ToolTransport` using the official MCP TypeScript client SDK. It supports Streamable HTTP and stdio servers. For HTTP, a keychain credential is sent as a bearer token; for stdio, it is supplied as `VIBECAB_MCP_TOKEN` in the child environment. OAuth flows are not included.

The engine performs tool discovery, schema validation, policy checks, grant checks, scope filtering, timeouts, result truncation, and audit logging. This adapter only connects and exchanges MCP messages.
