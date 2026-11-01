import { Children } from "react";
import type { CSSProperties, ReactNode } from "react";
import { PanelResizeHandle } from "../view/PanelResizeHandle.js";
import { usePanelWidth } from "../view/usePanelWidth.js";

export function SessionPanelLayout({ children, threadsVisible }: { children: ReactNode; threadsVisible: boolean }) {
  const [draftWidth, setDraftWidth] = usePanelWidth("vibecab.ui.sessionDraftRailWidth", 200, 150, 340),
    [threadWidth, setThreadWidth] = usePanelWidth("vibecab.ui.threadRailWidth", 360, 260, 600),
    [sidebar, content, threads] = Children.toArray(children);
  return (
    <div
      className={`session-grid${threadsVisible ? " has-threads" : ""}`}
      style={
        { "--session-drafts-width": `${draftWidth}px`, "--session-threads-width": `${threadWidth}px` } as CSSProperties
      }
    >
      {sidebar}
      <PanelResizeHandle label="Session Drafts panel" value={draftWidth} min={150} max={340} onChange={setDraftWidth} />
      {content}
      {threadsVisible ? (
        <>
          <PanelResizeHandle
            label="Threads panel"
            value={threadWidth}
            min={260}
            max={600}
            direction={-1}
            onChange={setThreadWidth}
          />
          {threads}
        </>
      ) : null}
    </div>
  );
}
