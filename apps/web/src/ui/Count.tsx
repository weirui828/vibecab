import { useEffect, useRef, useState } from "react";

/** A count that makes itself seen once when its number changes (not when it first shows). */
export function Count({ value, className = "count" }: { value: number; className?: string }) {
  const last = useRef(value),
    [bump, setBump] = useState(0);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    setBump((n) => n + 1);
  }, [value]);
  return (
    <span key={bump} className={className} data-bump={bump > 0 ? "" : undefined}>
      {value}
    </span>
  );
}
