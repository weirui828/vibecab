import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export function PanelResizeHandle({
  label,
  value,
  min,
  max,
  direction = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  direction?: 1 | -1;
  onChange: (value: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | undefined>(undefined);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    start.current = { x: event.clientX, width: value };
    const move = (current: PointerEvent) => {
      if (start.current) onChange(start.current.width + (current.clientX - start.current.x) * direction);
    };
    const stop = () => {
      start.current = undefined;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  return (
    <div
      className="panel-resize-handle"
      role="separator"
      aria-label={`Resize ${label}`}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onChange(value + (event.key === "ArrowRight" ? 12 : -12) * direction);
        }
      }}
    />
  );
}
