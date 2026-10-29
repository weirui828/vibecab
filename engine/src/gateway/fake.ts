import type { ModelProvider, ModelRequest, ModelCallOptions, ModelEvent, ProviderModel } from "./types.js";

type Scenario = { events: ModelEvent[] } | { hang: true };
export class ScriptedProvider implements ModelProvider {
  readonly calls: Array<{
    model: ProviderModel;
    request: ModelRequest;
    options: ModelCallOptions;
  }> = [];
  private readonly scenarios = new Map<string, Scenario>();
  private defaultSequence: ModelEvent[][] = [];
  enqueue(key: string, events: ModelEvent[]) {
    this.scenarios.set(key, { events });
  }
  enqueueHang(key: string) {
    this.scenarios.set(key, { hang: true });
  }
  enqueueDefaultSequence(sequence: ModelEvent[][]) {
    this.defaultSequence.push(...sequence.map((events) => [...events]));
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
    const scenario = this.scenarios.get(options.idempotencyKey ?? "") ?? {
      events: this.defaultSequence.shift() ?? [{ type: "done", finishReason: "stop" }],
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
      yield event;
    }
  }
}
