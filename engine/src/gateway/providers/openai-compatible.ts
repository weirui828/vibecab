import OpenAI from "openai";
import { fail } from "../../../../contract/src/index.js";
import type {
  KeyStore,
  ModelCallOptions,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ProviderModel,
} from "../types.js";

type CallState = { id: string; name: string; arguments: string };
export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    private readonly keys: KeyStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async *call(
    model: ProviderModel,
    request: ModelRequest,
    options: ModelCallOptions,
  ): AsyncIterable<ModelEvent> {
    if (!model.keyRef)
      fail("unauthenticated", "Provider key reference is not configured");
    let secret: string;
    try {
      secret = await this.keys.get(model.keyRef);
    } catch {
      yield {
        type: "error",
        code: "auth",
        message: "Provider key is unavailable",
        retryable: false,
      };
      return;
    }
    const client = new OpenAI({
      apiKey: secret,
      baseURL: model.baseUrl,
      fetch: this.fetcher,
      timeout: 0,
      maxRetries: 0,
    });
    const messages: OpenAI.ChatCompletionMessageParam[] = request.messages.map(
      (message) => {
        if (message.role === "tool")
          return {
            role: "tool",
            tool_call_id: message.toolCallId ?? "",
            content: message.content,
          };
        if (message.role === "assistant" && message.toolCalls)
          return {
            role: "assistant",
            content: message.content,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          };
        return { role: message.role, content: message.content };
      },
    );
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: model.model,
      messages,
      stream: true,
      ...(model.capabilities.reportsUsage
        ? { stream_options: { include_usage: true } }
        : {}),
      max_completion_tokens: request.maxOutputTokens,
      ...(request.temperature === undefined
        ? {}
        : { temperature: request.temperature }),
      ...(request.tools
        ? {
            tools: request.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      ...(request.output?.kind === "json"
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: request.output.name,
                strict: true,
                schema: request.output.schema,
              },
            },
          }
        : {}),
    };
    let jsonText = "";
    const toolCalls = new Map<number, CallState>();
    try {
      await options.onSent?.();
      const stream = await client.chat.completions.create(params, {
        signal: options.signal,
      });
      for await (const chunk of stream) {
        if (chunk.usage)
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            quality: "reported",
          };
        const choice = chunk.choices[0];
        if (!choice) continue;
        const text = choice.delta.content;
        if (typeof text === "string") {
          if (request.output?.kind === "json") jsonText += text;
          else yield { type: "text_delta", text };
        }
        for (const item of choice.delta.tool_calls ?? []) {
          const state = toolCalls.get(item.index) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (item.id) state.id = item.id;
          if (item.function?.name) state.name += item.function.name;
          if (item.function?.arguments)
            state.arguments += item.function.arguments;
          toolCalls.set(item.index, state);
        }
        if (choice.finish_reason === "tool_calls") {
          for (const call of [...toolCalls.values()].sort((a, b) =>
            a.id.localeCompare(b.id),
          )) {
            try {
              yield {
                type: "tool_call",
                call: {
                  id: call.id,
                  name: call.name,
                  arguments: JSON.parse(call.arguments),
                },
              };
            } catch {
              yield {
                type: "error",
                code: "provider_error",
                message: "Model returned an invalid tool call",
                retryable: false,
              };
            }
          }
        }
        if (choice.finish_reason) {
          if (request.output?.kind === "json") {
            try {
              yield { type: "output", json: JSON.parse(jsonText) };
            } catch {
              yield {
                type: "error",
                code: "provider_error",
                message: "Model returned invalid structured output",
                retryable: false,
              };
            }
          }
          yield {
            type: "done",
            finishReason:
              choice.finish_reason === "function_call"
                ? "tool_calls"
                : choice.finish_reason,
          };
        }
      }
    } catch (error) {
      if (options.signal.aborted) {
        yield {
          type: "error",
          code: "cancelled",
          message: "Model call cancelled",
          retryable: false,
        };
        return;
      }
      if (error instanceof OpenAI.APIError && error.status === 429) {
        yield {
          type: "error",
          code: "rate_limited",
          message: "Model provider rate limited the request",
          retryable: true,
        };
        return;
      }
      if (error instanceof OpenAI.APIError && error.status === 401) {
        yield {
          type: "error",
          code: "auth",
          message: "Model provider authentication failed",
          retryable: false,
        };
        return;
      }
      yield {
        type: "error",
        code: "provider_error",
        message: "Model provider failed",
        retryable:
          error instanceof OpenAI.APIError ? error.status >= 500 : true,
      };
    }
  }
}
