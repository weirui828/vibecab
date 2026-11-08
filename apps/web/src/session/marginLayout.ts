export interface MarginItem {
  id: string;
  /** Wanted top, in px from the top of the margin; undefined for items without a place in the text. */
  anchorTop: number | undefined;
  height: number;
}

const GAP = 12;

/**
 * Places margin cards next to their text: each at its anchor's height, pushed down to clear the card above.
 * Items without an anchor follow after the last anchored card. Input order breaks ties. Pure, for tests.
 */
export function layoutMargin(items: MarginItem[], pinned?: string): Map<string, number> {
  const anchored = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.anchorTop !== undefined)
      .sort((a, b) => (a.item.anchorTop ?? 0) - (b.item.anchorTop ?? 0) || a.index - b.index),
    loose = items.filter((item) => item.anchorTop === undefined);
  const tops = new Map<string, number>();
  let floor = 0;
  // The pinned card (the one being read or written) sits exactly at its text; cards above make room for it.
  const pin = anchored.find(({ item }) => item.id === pinned)?.item;
  if (pin?.anchorTop !== undefined) {
    let ceiling = pin.anchorTop - GAP;
    const above = anchored.filter(({ item }) => (item.anchorTop ?? 0) < (pin.anchorTop ?? 0) && item.id !== pin.id);
    for (const { item } of [...above].reverse()) {
      const top = Math.min(item.anchorTop ?? 0, ceiling - item.height);
      tops.set(item.id, top);
      ceiling = top - GAP;
    }
    // If the cards above ran out of room at the top, fall back to stacking from the top down.
    if (ceiling < -GAP) tops.clear();
  }
  for (const { item } of anchored) {
    const top = Math.max(tops.get(item.id) ?? item.anchorTop ?? 0, floor);
    tops.set(item.id, top);
    floor = top + item.height + GAP;
  }
  for (const item of loose) {
    tops.set(item.id, floor);
    floor += item.height + GAP;
  }
  return tops;
}
