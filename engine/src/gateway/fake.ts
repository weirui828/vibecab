import type { ModelProvider, ModelRequest, ModelCallOptions, ModelEvent, ProviderModel } from "./types.js";

type Scenario = { events: ModelEvent[] } | { hang: true };
type DefaultScenario = ModelEvent[] | ((model: ProviderModel, request: ModelRequest) => ModelEvent[]);
export class ScriptedProvider implements ModelProvider {
  readonly calls: Array<{
    model: ProviderModel;
    request: ModelRequest;
    options: ModelCallOptions;
  }> = [];
  private readonly scenarios = new Map<string, Scenario>();
  private defaultSequence: DefaultScenario[] = [];
  private defaultHandler: ((model: ProviderModel, request: ModelRequest) => ModelEvent[]) | undefined;
  enqueue(key: string, events: ModelEvent[]) {
    this.scenarios.set(key, { events });
  }
  enqueueHang(key: string) {
    this.scenarios.set(key, { hang: true });
  }
  enqueueDefaultSequence(sequence: ModelEvent[][]) {
    this.defaultSequence.push(...sequence.map((events) => [...events]));
  }
  enqueueDefaultFactory(factory: (model: ProviderModel, request: ModelRequest) => ModelEvent[]) {
    this.defaultSequence.push(factory);
  }
  setDefaultHandler(handler: (model: ProviderModel, request: ModelRequest) => ModelEvent[]): void {
    this.defaultHandler = handler;
  }
  async *call(model: ProviderModel, request: ModelRequest, options: ModelCallOptions): AsyncIterable<ModelEvent> {
    this.calls.push({ model, request, options });
    if (options.signal.aborted) {
      yield {
        type: "error",
        code: "cancelled",
        message: "Model call cancelled",
        retryable: false,
      };
      return;
    }
    await options.onSent?.();
    const configured = this.defaultSequence.shift(),
      scenario = this.scenarios.get(options.idempotencyKey ?? "") ?? {
        events:
          typeof configured === "function"
            ? configured(model, request)
            : (configured ?? this.defaultHandler?.(model, request) ?? [{ type: "done", finishReason: "stop" }]),
      };
    if ("hang" in scenario) {
      await new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      yield {
        type: "error",
        code: "cancelled",
        message: "Model call cancelled",
        retryable: false,
      };
      return;
    }
    const threadId = request.messages
      .map((message) => message.content)
      .join("\n")
      .match(/threadId=([^;\s]+)/)?.[1];
    for (const event of scenario.events) {
      if (options.signal.aborted) {
        yield {
          type: "error",
          code: "cancelled",
          message: "Model call cancelled",
          retryable: false,
        };
        return;
      }
      if (
        event.type === "tool_call" &&
        threadId &&
        typeof event.call.arguments === "object" &&
        event.call.arguments !== null &&
        !Array.isArray(event.call.arguments) &&
        Reflect.get(event.call.arguments, "threadId") === "$first_thread"
      ) {
        yield {
          ...event,
          call: {
            ...event.call,
            arguments: { ...event.call.arguments, threadId },
          },
        };
      } else yield event;
    }
  }
}
