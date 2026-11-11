import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { DiffResult, Element } from "../../../../contract/generated/index.js";
import { terms } from "../copy/terms.js";
import { AfterBlock } from "./DocumentView.js";
import { frameDocument, readFrameMessage } from "./htmlFrame.js";
import type { FrameBlock } from "./htmlFrame.js";

const FRAME = "/draft-frame";

function newToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") + Math.random().toString(36).slice(2);
}

/**
 * An HTML Draft, shown as the file it is. It lives in a frame with an origin of its own, no network, and no way
 * to reach VibeCab; over it lies one empty box per block, so comments, the plumb line and the changes view find
 * the blocks where the frame says they are.
 */
export function HtmlView({ elements, diff }: { elements: Element[]; diff?: DiffResult | undefined }) {
  const frame = useRef<HTMLIFrameElement>(null),
    token = useMemo(newToken, []),
    document_ = useMemo(() => frameDocument(elements, token), [elements, token]),
    known = useMemo(() => new Set(elements.filter((e) => e.type === "html_block").map((e) => e.elementId)), [elements]),
    [layout, setLayout] = useState<{ height: number; blocks: FrameBlock[] }>({ height: 240, blocks: [] }),
    [hover, setHover] = useState<string | null>(null),
    boxes = useRef(new Map<string, HTMLDivElement>()),
    grown = useRef(0),
    after = useContext(AfterBlock);
  // The frame is loaded once per Draft view; a new version reloads it with the new file.
  const [round, setRound] = useState(0);
  useEffect(() => setRound((n) => n + 1), [document_]);
  useEffect(() => {
    grown.current = 0;
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      // The empty frame says it is ready; the Draft goes to this view's own frame and nowhere else, whoever asked.
      // (A sandboxed frame's messages do not always name its window as their source, so the source is not checked;
      // every later message must carry the token that only this frame was given.)
      if (typeof data === "object" && data !== null && (data as { vcFrame?: unknown }).vcFrame === "ready") {
        frame.current?.contentWindow?.postMessage({ vcDraft: true, html: document_ }, "*");
        return;
      }
      const message = readFrameMessage(data, token, known);
      if (!message) return;
      if (message.type === "hover") return setHover(message.id);
      setLayout((old) => {
        // A page as tall as its window grows each time the frame does. A few rounds settle; after that, stop.
        if (message.height > old.height && ++grown.current > 8) return { ...old, blocks: message.blocks };
        return { height: message.height, blocks: message.blocks };
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [document_, token, known]);
  // The pointer is inside the frame, where the page cannot see it: pass it on to the block's box, so the page
  // treats it as its own.
  useEffect(() => {
    const box = hover ? boxes.current.get(hover) : undefined;
    box?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  }, [hover]);
  const changed = useMemo(() => new Set([...(diff?.changed ?? []), ...(diff?.added ?? [])]), [diff]);
  return (
    <div className="vc-doc vc-html">
      <iframe
        key={round}
        ref={frame}
        className="vc-html-frame"
        title={terms.draft}
        src={FRAME}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={{ height: layout.height }}
      />
      {layout.blocks.map((block) => (
        <div
          key={block.id}
          ref={(node) => void (node ? boxes.current.set(block.id, node) : boxes.current.delete(block.id))}
          className="vc-html-block"
          data-element-id={block.id}
          data-hover={hover === block.id || undefined}
          data-changed={changed.has(block.id) || undefined}
          style={{ top: block.top, left: block.left, width: block.width, height: block.height }}
        />
      ))}
      {after && <div className="vc-html-threads">{layout.blocks.map((block) => after(block.id))}</div>}
    </div>
  );
}
