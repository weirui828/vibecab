import type { JsonSchema, ToolServer } from "../../../contract/src/index.js";

export interface ExternalToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ExternalToolSession {
  listTools(): Promise<ExternalToolDefinition[]>;
  callTool(name: string, arguments_: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface ToolTransport {
  connect(server: ToolServer, credential?: string): Promise<ExternalToolSession>;
}
