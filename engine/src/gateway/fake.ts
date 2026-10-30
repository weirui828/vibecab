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
    const placeholders = extractPlaceholders(request);
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
      if (event.type === "tool_call" && threadId && getValue(event.call.arguments, "threadId") === "$first_thread") {
        yield {
          ...event,
          call: {
            ...event.call,
            arguments: replacePlaceholders(event.call.arguments, { ...placeholders, $first_thread: threadId }),
          },
        };
      } else yield replaceEvent(event, placeholders);
    }
  }
}

function extractPlaceholders(request: ModelRequest): Record<string, string> {
  const result: Record<string, string> = {};
  for (const message of request.messages) {
    try {
      const parsed: unknown = JSON.parse(message.content);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const items = getValue(parsed, "items"),
        elements = getValue(parsed, "elements"),
        item = Array.isArray(items) ? items[0] : undefined,
        element = Array.isArray(elements) ? elements[0] : undefined;
      const itemId = getValue(item, "itemId"),
        elementId = getValue(element, "elementId");
      if (typeof itemId === "string") result.$first_item = itemId;
      if (typeof elementId === "string") result.$first_element = elementId;
    } catch {
      // Non-JSON context messages do not define script aliases.
    }
  }
  return result;
}

function getValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
}

function replacePlaceholders(value: unknown, placeholders: Record<string, string>): unknown {
  if (typeof value === "string") return placeholders[value] ?? value;
  if (Array.isArray(value)) return value.map((item) => replacePlaceholders(item, placeholders));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePlaceholders(item, placeholders)]));
}

function replaceEvent(event: ModelEvent, placeholders: Record<string, string>): ModelEvent {
  if (event.type === "text_delta") {
    let text = event.text;
    for (const [alias, value] of Object.entries(placeholders)) text = text.replaceAll(alias, value);
    return { ...event, text };
  }
  if (event.type === "output") return { ...event, json: replacePlaceholders(event.json, placeholders) };
  if (event.type === "tool_call")
    return { ...event, call: { ...event.call, arguments: replacePlaceholders(event.call.arguments, placeholders) } };
  return event;
}
