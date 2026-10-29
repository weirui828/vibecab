export function findVerbatimQuote(text: string, quote: string, prefix?: string, suffix?: string): number | undefined {
  const positions: number[] = [];
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) positions.push(at);
  if (prefix !== undefined || suffix !== undefined) {
    const contextual = positions.filter(
      (at) =>
        (prefix === undefined || text.slice(Math.max(0, at - prefix.length), at) === prefix) &&
        (suffix === undefined || text.slice(at + quote.length, at + quote.length + suffix.length) === suffix),
    );
    if (contextual.length === 1) return contextual[0];
  }
  return positions.length === 1 ? positions[0] : undefined;
}

export function storeRequestIndex(store: import("../storage/repository.js").Repository, turnId: string): number {
  return store
    .feedbackList("manifest")
    .filter(
      (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value) && Reflect.get(value, "turnId") === turnId,
    ).length;
}
