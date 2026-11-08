import { fail, type Contract } from "../../../contract/src/index.js";
import type { Clock } from "../dependencies.js";
import type { BudgetLedger } from "./ledger.js";
import { estimateInputTokens, reportedCostMicros } from "./ledger.js";
import { agentFor } from "./types.js";
import type {
  ModelCallOptions,
  ModelCapabilities,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ProviderModel,
} from "./types.js";

const safeMessages: Record<
  "provider_error" | "rate_limited" | "auth" | "unsupported" | "timeout" | "cancelled",
  string
> = {
  provider_error: "Model provider failed",
  rate_limited: "Model provider rate limited the request",
  auth: "Model provider authentication failed",
  unsupported: "Model provider does not support the request",
  timeout: "Model provider request timed out",
  cancelled: "Model call cancelled",
};

export class ProviderGateway {
  constructor(
    private models: Record<string, ProviderModel>,
    private readonly providers: Record<string, ModelProvider>,
    private readonly ledger: BudgetLedger,
    private readonly contract: Contract,
    private readonly clock: Clock = { now: () => new Date().toISOString() },
  ) {}
  setModels(models: Record<string, ProviderModel>) {
    this.models = models;
  }
  capabilities(modelRef: string): ModelCapabilities {
    const model = this.models[modelRef];
    if (!model) fail("unsupported", "Model alias is not configured");
    return model.capabilities;
  }
  async *call(request: ModelRequest, options: ModelCallOptions): AsyncIterable<ModelEvent> {
    const model = this.models[request.modelRef];
    if (!model) fail("unsupported", "Model alias is not configured");
    if (request.tools?.length && !model.capabilities.tools)
      fail("unsupported", "Configured model does not support tools");
    if (request.output?.kind === "json" && !model.capabilities.jsonSchemaOutput)
      fail("unsupported", "Configured model does not support structured output");
    if (!model.capabilities.streaming) fail("unsupported", "Configured model does not support streaming");
    if (estimateInputTokens(request) + request.maxOutputTokens > model.capabilities.maxContextTokens)
      fail("unsupported", "Request exceeds the configured model context window");
    if (request.output?.kind === "json" && !this.contract.schemaIsValid(request.output.schema))
      fail("invalid", "Structured output schema is invalid");
    const provider = this.providers[model.provider];
    if (!provider) fail("unsupported", "Configured model provider is unavailable");
    // The agent's own instructions go with every request it makes, VibeCab or TMR (W13).
    const instructions = model.instructions?.trim();
    if (instructions) request = withInstructions(request, instructions);
    const reservation = this.ledger.assertReserved(options.reservationId),
      startedAt = this.clock.now(),
      startMs = Date.parse(startedAt);
    let quality: "reported" | "estimated" | "unknown" = "unknown",
      inputTokens: number | undefined,
      outputTokens: number | undefined,
      cachedInputTokens: number | undefined;
    let finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error" = "error",
      errorCode: string | undefined;
    try {
      for await (const event of provider.call(model, request, options)) {
        if (event.type === "usage") {
          quality = event.quality;
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          cachedInputTokens = event.cachedInputTokens;
          yield event;
          continue;
        }
        if (event.type === "done") {
          finishReason = event.finishReason;
          yield event;
          continue;
        }
        if (event.type === "error") {
          errorCode = event.code;
          yield { ...event, message: safeMessages[event.code] };
          continue;
        }
        if (event.type === "output" && request.output?.kind === "json") {
          if (!this.contract.validates(request.output.schema, event.json)) {
            errorCode = "provider_error";
            yield {
              type: "error",
              code: "provider_error",
              message: "Model returned invalid structured output",
              retryable: false,
            };
            break;
          }
        }
        yield event;
      }
    } catch {
      errorCode = options.signal.aborted ? "cancelled" : "provider_error";
      yield {
        type: "error",
        code: options.signal.aborted ? "cancelled" : "provider_error",
        message: options.signal.aborted ? safeMessages.cancelled : safeMessages.provider_error,
        retryable: options.signal.aborted ? false : true,
      };
    } finally {
      let settledMicros = reservation.amountMicros;
      if (quality !== "unknown" && inputTokens !== undefined && outputTokens !== undefined) {
        try {
          const cost = reportedCostMicros(inputTokens, outputTokens, model);
          this.ledger.settle(options.reservationId, cost, quality);
          settledMicros = cost;
        } catch {
          errorCode = "provider_error";
          this.ledger.markUncertain(options.reservationId);
        }
      } else this.ledger.markUncertain(options.reservationId);
      const settled = this.ledger.reservation(options.reservationId);
      if (settled.state === "uncertain") settledMicros = reservation.amountMicros;
      this.ledger.log(
        this.contract.read("call-log", {
          callId: options.reservationId,
          alias: request.modelRef,
          model: model.model,
          reservationId: options.reservationId,
          reservedMicros: reservation.amountMicros,
          settledMicros,
          usageQuality: settled.usageQuality ?? "unknown",
          finishReason,
          durationMs: Math.max(0, Date.parse(this.clock.now()) - startMs),
          ...(errorCode ? { errorCode } : {}),
          // A call is the pool agent's whose model it used, whoever asked (W13).
          ...(options.attribution ? { agentId: agentFor(request.modelRef) } : {}),
          ...(options.attribution?.sessionId ? { sessionId: options.attribution.sessionId } : {}),
          ...(options.attribution?.purpose ? { purpose: options.attribution.purpose } : {}),
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
          createdAt: startedAt,
        }),
      );
    }
  }
}

/** The request with the agent's instructions added after its system messages. */
function withInstructions(request: ModelRequest, instructions: string): ModelRequest {
  const system = request.messages.filter((m) => m.role === "system"),
    rest = request.messages.filter((m) => m.role !== "system");
  return {
    ...request,
    messages: [
      ...system,
      { role: "system", content: "Instructions from the person who set you up:\n" + instructions },
      ...rest,
    ],
  };
}
