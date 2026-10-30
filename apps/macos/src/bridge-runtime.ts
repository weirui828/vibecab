export async function retryUnauthenticated<T>(action: () => Promise<T>, recover: () => Promise<void>): Promise<T> {
  const first = await action();
  if (!isUnauthenticatedResult(first)) return first;
  await recover();
  return action();
}

function isUnauthenticatedResult(value: unknown): boolean {
  if (isUnauthenticatedError(value)) return true;
  if (typeof value !== "object" || value === null || Reflect.get(value, "ok") !== false) return false;
  return isUnauthenticatedError(Reflect.get(value, "error"));
}

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof Error && "code" in error && Reflect.get(error, "code") === "unauthenticated";
}

export function isUnauthenticatedError(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "code") === "unauthenticated";
}

export async function* reconnectEvents<T extends { seq: number }>(
  afterSeq: number,
  signal: AbortSignal,
  subscribe: (cursor: number) => AsyncIterable<T>,
  onError: (error: unknown) => Promise<void>,
  reconnectDelayMs = 300,
): AsyncGenerator<T> {
  let cursor = afterSeq;
  while (!signal.aborted) {
    try {
      for await (const event of subscribe(cursor)) {
        if (signal.aborted) return;
        if (event.seq <= cursor) continue;
        cursor = event.seq;
        yield event;
      }
    } catch (error) {
      if (signal.aborted) return;
      await onError(error);
    }
    if (!signal.aborted) await new Promise((resolveDelay) => setTimeout(resolveDelay, reconnectDelayMs));
  }
}
