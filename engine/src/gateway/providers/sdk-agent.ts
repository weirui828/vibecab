import { tmpdir } from "node:os";
import type { ModelCallOptions, ModelEvent, ModelProvider, ModelRequest, ProviderModel, ToolCall } from "../types.js";

// Claude Code and Codex as model providers (W12). The SDK agent runs with this computer's own sign-in and its own
// tools turned off; it only answers, in one strict JSON shape, what it wants to say and which of the offered tools
// it wants to call. The engine then runs those tools itself — validated, as the agent — so an SDK agent can never
// act as the person or do anything the built-in agent could not. Its price here is zero: its subscription pays.

export type SdkProviderKind = "claude-agent-sdk" | "codex-sdk";

/** One run of an SDK agent: the whole conversation as one prompt, and the shape its answer must take. */
export interface SdkRun {
  prompt: string;
  schema: Record<string, unknown>;
  /** The model to ask for; undefined lets the SDK use its own default. */
  model: string | undefined;
  signal: AbortSignal;
}
export interface SdkResult {
  json: unknown;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}
export type SdkRunner = (run: SdkRun) => Promise<SdkResult>;

/** The agent id each SDK provider records its calls and budgets under. */
export const sdkAgentOf: Record<SdkProviderKind, string> = { "claude-agent-sdk": "claude-code", "codex-sdk": "codex" };

/** A model config for an SDK agent: no key (the SDK has its own sign-in), priced at zero. "default" = SDK default. */
export function sdkModel(kind: SdkProviderKind, model = "default"): ProviderModel {
  return {
    provider: kind,
    baseUrl: kind === "claude-agent-sdk" ? "sdk://claude-code" : "sdk://codex",
    model,
    capabilities: {
      tools: true,
      jsonSchemaOutput: true,
      streaming: true,
      maxContextTokens: 200_000,
      reportsUsage: true,
    },
    pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
  };
}

/** Strict for both SDKs: every property required, no open objects (tool arguments and output travel as JSON text). */
const answerSchema = (toolNames: string[]) => ({
  type: "object",
  properties: {
    text: { type: "string", description: "What you say, if anything." },
    toolCalls: {
      type: "array",
      description: "Tools you call, in order. Only the tools listed in the prompt.",
      items: {
        type: "object",
        properties: {
          name: toolNames.length ? { type: "string", enum: toolNames } : { type: "string" },
          argumentsJson: { type: "string", description: "The tool's arguments as a JSON object, written as text." },
        },
        required: ["name", "argumentsJson"],
        additionalProperties: false,
      },
    },
    outputJson: {
      type: "string",
      description: "When the prompt asks for structured output: that JSON, as text. Else empty.",
    },
  },
  required: ["text", "toolCalls", "outputJson"],
  additionalProperties: false,
});

/** The conversation, the tools on offer and the expected output, as one prompt. */
export function renderPrompt(request: ModelRequest): string {
  const parts = [
    "You are working inside VibeCab as its agent. Do not use any tools of your own, files, or the network.",
    "Answer only with the JSON object your output format asks for.",
  ];
  for (const message of request.messages) {
    if (message.role === "tool") parts.push(`## Result of tool call ${message.toolCallId ?? ""}\n${message.content}`);
    else {
      parts.push(`## ${message.role[0]!.toUpperCase() + message.role.slice(1)}\n${message.content}`);
      for (const call of message.toolCalls ?? [])
        parts.push(
          `(The assistant called ${JSON.stringify(call.name)} as ${call.id} with ${JSON.stringify(call.arguments)}.)`,
        );
    }
  }
  if (request.tools?.length)
    parts.push(
      "## Tools you may call\nTo call one, add it to toolCalls with its arguments as JSON text.\n" +
        request.tools
          .map(
            (t) => `- ${JSON.stringify(t.name)}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`,
          )
          .join("\n"),
    );
  if (request.output?.kind === "json")
    parts.push(
      `## Output\nPut your answer in outputJson, as JSON text matching this schema:\n${JSON.stringify(request.output.schema)}`,
    );
  return parts.join("\n\n");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class SdkAgentProvider implements ModelProvider {
  constructor(private readonly runner: SdkRunner) {}

  async *call(model: ProviderModel, request: ModelRequest, options: ModelCallOptions): AsyncIterable<ModelEvent> {
    const fail = (message: string): ModelEvent => ({
      type: "error",
      code: "provider_error",
      message,
      retryable: false,
    });
    if (options.signal.aborted) {
      yield { type: "error", code: "cancelled", message: "Model call cancelled", retryable: false };
      return;
    }
    const toolNames = (request.tools ?? []).map((t) => t.name);
    let result: SdkResult;
    try {
      await options.onSent?.();
      result = await this.runner({
        prompt: renderPrompt(request),
        schema: answerSchema(toolNames),
        model: model.model === "default" ? undefined : model.model,
        signal: options.signal,
      });
    } catch {
      yield options.signal.aborted
        ? { type: "error", code: "cancelled", message: "Model call cancelled", retryable: false }
        : fail("The agent did not answer");
      return;
    }
    // What came back is untrusted until it fits: the right shape, offered tools only, arguments that parse.
    const answer = result.json;
    if (!isRecord(answer) || typeof answer.text !== "string" || !Array.isArray(answer.toolCalls)) {
      yield fail("The agent's answer was not in the expected shape");
      return;
    }
    const calls: ToolCall[] = [];
    for (const [index, raw] of answer.toolCalls.entries()) {
      if (
        !isRecord(raw) ||
        typeof raw.name !== "string" ||
        !toolNames.includes(raw.name) ||
        typeof raw.argumentsJson !== "string"
      ) {
        yield fail("The agent asked for a tool it was not offered");
        return;
      }
      let args: unknown;
      try {
        args = JSON.parse(raw.argumentsJson);
      } catch {
        yield fail("The agent's tool arguments were not JSON");
        return;
      }
      calls.push({ id: `${options.reservationId}:${index}`, name: raw.name, arguments: args });
    }
    let output: unknown;
    if (request.output?.kind === "json") {
      try {
        output = JSON.parse(typeof answer.outputJson === "string" ? answer.outputJson : "");
      } catch {
        yield fail("The agent's structured output was not JSON");
        return;
      }
    }
    if (answer.text) yield { type: "text_delta", text: answer.text };
    for (const call of calls) yield { type: "tool_call", call };
    if (output !== undefined) yield { type: "output", json: output };
    if (result.usage)
      yield {
        type: "usage",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(result.usage.cachedInputTokens !== undefined ? { cachedInputTokens: result.usage.cachedInputTokens } : {}),
        quality: "reported",
      };
    yield { type: "done", finishReason: calls.length ? "tool_calls" : "stop" };
  }
}

/** Claude Code through the Claude Agent SDK, with this computer's sign-in. Loaded only when first used. */
export const claudeCodeRunner: SdkRunner = async ({ prompt, schema, model, signal }) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });
  for await (const message of query({
    prompt,
    options: {
      ...(model ? { model } : {}),
      // No built-in tools, no project or user settings: it answers, VibeCab acts.
      tools: [],
      allowedTools: [],
      settingSources: [],
      cwd: tmpdir(),
      maxTurns: 4,
      outputFormat: { type: "json_schema", schema },
      abortController,
    },
  })) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success" || message.is_error) throw new Error("Claude Code did not finish");
    return {
      json: message.structured_output,
      usage: {
        inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
        cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
  throw new Error("Claude Code gave no result");
};

/** Codex through the Codex SDK, with this computer's sign-in, read-only and offline. Loaded only when first used. */
export const codexRunner: SdkRunner = async ({ prompt, schema, model, signal }) => {
  const { Codex } = await import("@openai/codex-sdk");
  const thread = new Codex().startThread({
    ...(model ? { model } : {}),
    sandboxMode: "read-only",
    skipGitRepoCheck: true,
    workingDirectory: tmpdir(),
    networkAccessEnabled: false,
  });
  const turn = await thread.run(prompt, { outputSchema: schema, signal });
  return {
    json: JSON.parse(turn.finalResponse),
    ...(turn.usage
      ? {
          usage: {
            inputTokens: turn.usage.input_tokens,
            outputTokens: turn.usage.output_tokens,
            cachedInputTokens: turn.usage.cached_input_tokens,
          },
        }
      : {}),
  };
};
