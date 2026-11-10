import { useLayoutEffect, useRef } from "react";

/**
 * One highlight that slides to the current item (the sidebar's current page, the selected tab) instead of
 * jumping. It sits inside the list and measures the item matching `selector` after every render; the item keeps
 * its own highlight until the glider is placed, so nothing depends on the measurement.
 */
export function Glider({ selector }: { selector: string }) {
  const ref = useRef<HTMLSpanElement>(null),
    placed = useRef(false);
  useLayoutEffect(() => {
    const glider = ref.current,
      parent = glider?.parentElement;
    if (!glider || !parent) return;
    const place = () => {
      const target = [...parent.querySelectorAll<HTMLElement>(selector)].find((node) => node.offsetParent !== null);
      const from = parent.getBoundingClientRect(),
        to = target?.getBoundingClientRect();
      if (!to || to.width === 0) {
        glider.removeAttribute("data-on");
        placed.current = false;
        return;
      }
      // The first placement must not slide in from the corner.
      if (!placed.current) glider.style.transition = "none";
      glider.style.width = to.width + "px";
      glider.style.height = to.height + "px";
      glider.style.transform = `translate(${to.left - from.left + parent.scrollLeft - parent.clientLeft}px, ${
        to.top - from.top + parent.scrollTop - parent.clientTop
      }px)`;
      glider.setAttribute("data-on", "");
      if (!placed.current) {
        void glider.offsetWidth;
        glider.style.transition = "";
        placed.current = true;
      }
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(parent);
    return () => observer.disconnect();
  });
  return <span ref={ref} className="vc-glider" aria-hidden="true" />;
}
