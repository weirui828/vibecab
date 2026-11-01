import type {
  DeliveryState,
  Element,
  VcSessionsOperation,
  VcThreadsOperation,
} from "../../../../contract/generated/index.js";

export function getSessionHeaderMeta(
  session: VcSessionsOperation["result"][number],
  elements: Element[],
  threads: VcThreadsOperation["result"],
  delivery: Record<string, DeliveryState["state"]>,
): string {
  const openThreads = threads.filter((thread) =>
      thread.comments.some((comment) => ["open", "discussing", "agreed", "scheduled"].includes(comment.state)),
    ).length,
    waitingOnAgent = Object.values(delivery).filter((state) => state === "queued" || state === "delivered").length,
    replyMode = { realtime: "live replies", batch: "batched replies", manual: "manual replies" }[session.replyTrigger];
  return [
    `${elements.filter((element) => element.parentId === null).length} blocks`,
    `${openThreads} open ${openThreads === 1 ? "thread" : "threads"}`,
    ...(waitingOnAgent ? [`${waitingOnAgent} waiting on the agent`] : []),
    replyMode,
  ].join(" · ");
}
