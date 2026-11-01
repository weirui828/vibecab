import { useCallback, useEffect, useState } from "react";

export function usePanelWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(key));
      return Number.isFinite(stored) && stored >= min && stored <= max ? stored : initial;
    } catch {
      return initial;
    }
  });
  const updateWidth = useCallback(
    (next: number) => setWidth(Math.round(Math.min(max, Math.max(min, next)))),
    [max, min],
  );
  useEffect(() => {
    try {
      localStorage.setItem(key, String(width));
    } catch {
      // Panel sizing is a convenience; keep the current layout if storage is unavailable.
    }
  }, [key, width]);
  return [width, updateWidth] as const;
}

export function useWorkspaceSidebar() {
  const [width, setWidth] = usePanelWidth("vibecab.ui.sidebarWidth", 248, 200, 360),
    [collapsed, setCollapsed] = useState(() => {
      try {
        return localStorage.getItem("vibecab.ui.sidebarCollapsed") === "true";
      } catch {
        return false;
      }
    });
  useEffect(() => {
    try {
      localStorage.setItem("vibecab.ui.sidebarCollapsed", String(collapsed));
    } catch {
      // Keep the collapsed state for this window if storage is unavailable.
    }
  }, [collapsed]);
  return { width, setWidth, collapsed, toggle: () => setCollapsed((value) => !value) };
}
