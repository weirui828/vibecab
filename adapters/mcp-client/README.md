# VibeCab MCP client adapter

Implements the engine's `ToolTransport` using the official MCP TypeScript client SDK. It supports Streamable HTTP and stdio servers. For HTTP, a keychain credential is sent as a bearer token; for stdio, `credentialEnv` names the single child environment variable that receives the keychain secret. Only that variable name is stored, and the public `ToolServers` query omits it. Keep secrets out of the ordinary `env` map. OAuth flows are not included.

The engine performs tool discovery, schema validation, policy checks, grant checks, scope filtering, timeouts, result truncation, and audit logging. This adapter only connects and exchanges MCP messages.
