import type {
  BudgetAccount as ContractBudgetAccount,
  BudgetReservation as ContractBudgetReservation,
  CallLog as ContractCallLog,
  JsonSchema,
  ProviderModel as ContractProviderModel,
  Settings as ContractSettings,
} from "../../../contract/src/index.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
export interface ModelRequest {
  modelRef: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
    toolCalls?: ToolCall[];
  }>;
  tools?: Array<{ name: string; description: string; parameters: JsonSchema }>;
  output?: { kind: "text" } | { kind: "json"; schema: JsonSchema; name: string };
  maxOutputTokens: number;
  temperature?: number;
}
export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "output"; json: unknown }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      quality: "reported" | "estimated" | "unknown";
    }
  | {
      type: "done";
      finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error";
    }
  | {
      type: "error";
      code: "provider_error" | "rate_limited" | "auth" | "unsupported" | "timeout" | "cancelled";
      message: string;
      retryable: boolean;
    };
export type ProviderModel = ContractProviderModel;
export type ModelCapabilities = ProviderModel["capabilities"];
export interface ModelCallOptions {
  reservationId: string;
  idempotencyKey?: string;
  signal: AbortSignal;
  onSent?: () => Promise<void>;
}
export interface ModelGateway {
  call(request: ModelRequest, options: ModelCallOptions): AsyncIterable<ModelEvent>;
  capabilities(modelRef: string): ModelCapabilities;
}
export interface ModelProvider {
  call(model: ProviderModel, request: ModelRequest, options: ModelCallOptions): AsyncIterable<ModelEvent>;
}
export interface KeyStore {
  get(ref: string): Promise<string>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<void>;
}
export type BudgetScope = ContractBudgetAccount;
export type BudgetReservation = ContractBudgetReservation;
export type CallLog = ContractCallLog;
export type SettingsDocument = ContractSettings;
