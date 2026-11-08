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

/** Where threads show on a wide screen: under each block (as covibe does) or in a margin beside the text. */
export type CommentPlace = "below" | "beside";
export function useCommentPlace(): [CommentPlace, (place: CommentPlace) => void] {
  const [place, setPlace] = useState<CommentPlace>(() => (read("vc-comments") === "beside" ? "beside" : "below"));
  const set = useCallback((next: CommentPlace) => {
    write("vc-comments", next);
    setPlace(next);
  }, []);
  return [place, set];
}

/** The sidebar folded to a rail of icons, remembered per browser. */
export function useSidebarRail(): [boolean, (railed: boolean) => void] {
  const [railed, setRailed] = useState(() => read("vc-sidebar") === "rail");
  const set = useCallback((next: boolean) => {
    write("vc-sidebar", next ? "rail" : "full");
    setRailed(next);
  }, []);
  return [railed, set];
}
