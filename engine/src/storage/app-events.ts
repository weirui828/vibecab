import type { EventEnvelope, Json } from "../../../contract/src/index.js";
import type { ContractValidator } from "../kernel/module-registry.js";

type EventSink = { appendEvent(event: Omit<EventEnvelope, "seq">): EventEnvelope };

export function appendFeedbackStateEvents(
  sink: EventSink,
  contract: ContractValidator,
  kind: string,
  id: string,
  before: Json | undefined,
  value: Json,
): void {
  if (kind === "update" || kind === "agent-turn" || kind === "delivery-state") appendStateChange();
  if (kind === "hold") appendHoldChange();

  function appendStateChange(): void {
    const oldState = field(before, "status") ?? field(before, "state"),
      newState = field(value, "status") ?? field(value, "state");
    if (newState === oldState || typeof newState !== "string") return;
    const ts = field(value, "updatedAt") ?? field(value, "completedAt") ?? field(value, "createdAt");
    if (typeof ts !== "string") throw Error("App event transition is missing a timestamp");
    if (kind === "update") {
      const payload = {
        updateId: field(value, "updateId"),
        artifactId: field(value, "artifactId"),
        status: newState,
        ...(typeof field(value, "resultVersion") === "number" ? { resultVersion: field(value, "resultVersion") } : {}),
      };
      sink.appendEvent({
        ts,
        type: "vc.UpdateChanged",
        entity: { kind: "update", id },
        payload: contract.read("events/vc.UpdateChanged", payload),
      });
    } else if (kind === "agent-turn") {
      const payload = {
        turnId: field(value, "turnId"),
        sessionId: field(value, "sessionId"),
        kind: "reply",
        status: newState,
      };
      sink.appendEvent({
        ts,
        type: "vc.AgentTurnChanged",
        entity: { kind: "agent_turn", id },
        payload: contract.read("events/vc.AgentTurnChanged", payload),
      });
    } else {
      const payload = { commentIds: [field(value, "commentId")], state: newState };
      sink.appendEvent({
        ts,
        type: "vc.DeliveryStateChanged",
        entity: { kind: "delivery_state", id },
        payload: contract.read("events/vc.DeliveryStateChanged", payload),
      });
    }
  }

  function appendHoldChange(): void {
    const wasHeld = before !== undefined && field(before, "releasedAt") === undefined,
      isHeld = field(value, "releasedAt") === undefined;
    if (wasHeld === isHeld) return;
    const artifactId = field(value, "artifactId"),
      elementId = field(value, "elementId"),
      ts = field(value, "releasedAt") ?? field(value, "lastActivity");
    if (typeof artifactId !== "string" || typeof elementId !== "string" || typeof ts !== "string") return;
    sink.appendEvent({
      ts,
      type: "vc.HoldChanged",
      entity: { kind: "artifact", id: artifactId },
      payload: contract.read("events/vc.HoldChanged", { artifactId, elementId, held: isHeld }),
    });
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
