import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

// Per-browser preferences. Storage can be unavailable (private windows); everything works without it.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export type ThemeChoice = "auto" | "light" | "dark";
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const stored = read("vc-theme");
    return stored === "light" || stored === "dark" ? stored : "auto";
  });
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = choice === "dark" || (choice === "auto" && media?.matches === true);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    media?.addEventListener?.("change", apply);
    return () => media?.removeEventListener?.("change", apply);
  }, [choice]);
  const set = useCallback((next: ThemeChoice) => {
    write("vc-theme", next);
    setChoice(next);
  }, []);
  return [choice, set];
}

function subscribeHash(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}
export function useRoute(): string {
  return useSyncExternalStore(subscribeHash, () => window.location.hash.slice(1) || "/");
}
export function navigate(path: string) {
  window.location.hash = path;
}
