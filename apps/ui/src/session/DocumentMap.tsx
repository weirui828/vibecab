import { useEffect, useState } from "react";
import type { Element } from "../../../../contract/generated/index.js";

type Marker = { elementId: string; label: string; top: number; width: number; active: boolean };
type MapBounds = { height: number; left: number; top: number; markers: Marker[] };

export function DocumentMap({ elements }: { elements: Element[] }) {
  const [bounds, setBounds] = useState<MapBounds>();
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>(".session-main"),
      region = document.querySelector<HTMLElement>(".document-region"),
      header = document.querySelector<HTMLElement>(".session-header");
    if (!scroller || !region || !header) return;
    const blocks = elements
      .filter((element) => element.parentId === null)
      .sort((a, b) => a.order.localeCompare(b.order));
    let frame = 0;
    const measure = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const scrollRect = scroller.getBoundingClientRect(),
          regionRect = region.getBoundingClientRect(),
          headerBottom = header.getBoundingClientRect().bottom,
          top = Math.max(scrollRect.top + 12, headerBottom + 12),
          height = Math.min(420, scrollRect.bottom - top - 16),
          maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight),
          visibleBlock = blocks.find((block) => {
            const node = document.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(block.elementId)}"]`);
            return node && node.getBoundingClientRect().bottom > headerBottom + 4;
          })?.elementId;
        if (height < 100 || blocks.length < 4) {
          setBounds(undefined);
          return;
        }
        const markers = blocks.flatMap((block) => {
          const node = document.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(block.elementId)}"]`);
          if (!node) return [];
          const topInDocument = scroller.scrollTop + node.getBoundingClientRect().top - scrollRect.top,
            label = "text" in block ? block.text.replace(/\s+/g, " ").trim() : block.type,
            width = Math.max(8, Math.min(22, Math.round(label.length / 9)));
          return [
            {
              elementId: block.elementId,
              label: label.slice(0, 80) || block.type,
              top: Math.max(0, Math.min(height - 3, (topInDocument / maxScroll) * height)),
              width,
              active: block.elementId === visibleBlock,
            },
          ];
        });
        setBounds({ height, left: regionRect.left + 4, top, markers });
      });
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(region);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [elements]);

  if (!bounds) return null;
  return (
    <nav
      className="document-map"
      aria-label="Document position"
      style={{ left: bounds.left, top: bounds.top, height: bounds.height }}
    >
      {bounds.markers.map((marker) => (
        <button
          key={marker.elementId}
          type="button"
          className="document-map-mark"
          data-active={marker.active || undefined}
          aria-label={`Jump to ${marker.label}`}
          title={marker.label}
          style={{ top: marker.top, width: marker.width }}
          onClick={() => {
            const scroller = document.querySelector<HTMLElement>(".session-main"),
              header = document.querySelector<HTMLElement>(".session-header"),
              node = document.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(marker.elementId)}"]`);
            if (!scroller || !header || !node) return;
            const target =
              scroller.scrollTop +
              node.getBoundingClientRect().top -
              scroller.getBoundingClientRect().top -
              header.offsetHeight -
              8;
            scroller.scrollTo({ top: target, behavior: "smooth" });
          }}
        />
      ))}
    </nav>
  );
}
