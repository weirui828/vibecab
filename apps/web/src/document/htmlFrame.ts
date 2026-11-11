import type { Element } from "../../../../contract/generated/index.js";
import { htmlDocument } from "../../../../contract/src/html-document.js";

// What goes into the frame an HTML Draft is shown in, and what comes back out of it.
// The frame has an origin of its own, so the page cannot look inside it: a small script, written into the Draft's
// head, tells the page where the blocks are and which one the pointer is on. Each message carries a token made
// for that frame. A Draft's own scripts could read it and send the same messages; all they can do with them is
// move VibeCab's comment button, so the token only keeps other frames and windows from being mistaken for it.

export interface FrameBlock {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
}
export type FrameMessage =
  { type: "layout"; height: number; blocks: FrameBlock[] } | { type: "hover"; id: string | null };

const MAX_HEIGHT = 60_000;

/** The script inside the frame. It only measures and reports; it changes nothing in the Draft. */
const reporter = (token: string) =>
  `<script>(function () {
  var token = ${JSON.stringify(token)};
  function send(message) { message.vc = token; parent.postMessage(message, "*"); }
  function measure() {
    var blocks = [];
    document.querySelectorAll("[data-vc-el]").forEach(function (node) {
      var box = node.getBoundingClientRect();
      if (box.height > 0) blocks.push({ id: node.getAttribute("data-vc-el"), top: box.top + scrollY, left: box.left, width: box.width, height: box.height });
    });
    var body = document.body ? document.body.scrollHeight : 0;
    send({ type: "layout", height: Math.max(document.documentElement.scrollHeight, body), blocks: blocks });
  }
  addEventListener("load", measure);
  addEventListener("resize", measure);
  if (window.ResizeObserver) new ResizeObserver(measure).observe(document.documentElement);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  setTimeout(measure, 0);
  var last = null;
  addEventListener("mousemove", function (event) {
    var node = event.target && event.target.closest ? event.target.closest("[data-vc-el]") : null,
      id = node ? node.getAttribute("data-vc-el") : null;
    if (id !== last) send({ type: "hover", id: (last = id) });
  }, { passive: true });
  // A link would take the frame somewhere else and leave the Draft; only links within the page work.
  addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (link && link.getAttribute("href").charAt(0) !== "#") event.preventDefault();
  }, true);
})();</script>`;

/** The Draft as one HTML document for the frame: the file itself, each block tagged with its element id. */
export function frameDocument(elements: Element[], token: string): string {
  return htmlDocument(
    elements,
    (element) => (element.type === "html_block" ? ` data-vc-el="${element.elementId}"` : ""),
    reporter(token),
  );
}

const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Reads a message from the frame. Anything without the token, or not shaped as expected, is nothing. */
export function readFrameMessage(data: unknown, token: string, known: ReadonlySet<string>): FrameMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  if (message.vc !== token) return undefined;
  if (message.type === "hover")
    return { type: "hover", id: typeof message.id === "string" && known.has(message.id) ? message.id : null };
  if (message.type !== "layout" || !number(message.height) || !Array.isArray(message.blocks)) return undefined;
  const blocks = (message.blocks as unknown[]).flatMap((raw): FrameBlock[] => {
    const block = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>,
      { id, top, left, width, height } = block;
    return typeof id === "string" && known.has(id) && number(top) && number(left) && number(width) && number(height)
      ? [{ id, top, left, width, height }]
      : [];
  });
  return { type: "layout", height: Math.min(Math.max(0, Math.ceil(message.height)), MAX_HEIGHT), blocks };
}

/** Is this a tree of HTML elements (an HTML Draft) rather than Document blocks? */
export const isHtmlDraft = (elements: Element[]) => elements.some((e) => e.type.startsWith("html_"));
