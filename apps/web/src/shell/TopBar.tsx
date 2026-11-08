import { useEffect, useRef, useState } from "react";
import { Icon } from "@wei/design-system";
import { Wordmark } from "../ui/Brand.js";
import { ConnectionLabel, ThemeSwitch, primaryNav } from "./Navigation.js";
import type { NavProps } from "./Navigation.js";

const isCurrent = (route: string, path: string) => (path === "/" ? route === "/" : route.startsWith(path));

/** Version B: one slim bar, Handscroll-style. Sessions live on Home; a floating dock replaces the bar on phones. */
export function TopBar({ route, needsYou, connection, theme, setTheme }: NavProps) {
  const [themeOpen, setThemeOpen] = useState(false),
    themeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!themeOpen) return;
    const away = (event: PointerEvent) => {
      if (!themeRef.current?.contains(event.target as Node)) setThemeOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && setThemeOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [themeOpen]);
  return (
    <>
      <header className="vc-topbar">
        <a href="#/" style={{ display: "inline-flex" }}>
          <Wordmark height={26} />
        </a>
        <nav className="vc-segmented" aria-label="Main">
          {primaryNav.map((item) => (
            <a key={item.path} href={"#" + item.path} aria-current={isCurrent(route, item.path) ? "page" : undefined}>
              {item.label}
              {item.path === "/needs-you" && needsYou > 0 && <span className="count">{needsYou}</span>}
            </a>
          ))}
        </nav>
        <div className="end">
          {connection !== "Connected" && <ConnectionLabel state={connection} />}
          <div ref={themeRef} style={{ position: "relative" }}>
            <button
              type="button"
              className="vc-icon-link"
              aria-label="Theme"
              title="Theme"
              aria-expanded={themeOpen}
              onClick={() => setThemeOpen((open) => !open)}
            >
              <Icon name={theme === "dark" ? "moon" : "sun"} size={20} />
            </button>
            {themeOpen && (
              <div className="vc-menu" style={{ right: 0, top: "calc(100% + 6px)", minWidth: 0 }}>
                <ThemeSwitch theme={theme} setTheme={setTheme} small />
              </div>
            )}
          </div>
          <a href="#/trash" aria-label="Trash" title="Trash" className="vc-icon-link">
            <Icon name="trash" size={20} />
          </a>
          <a href="#/settings" aria-label="Settings" title="Settings" className="vc-icon-link wide-only">
            <Icon name="cog-6-tooth" size={20} />
          </a>
        </div>
      </header>
      <nav className="vc-dock" aria-label="Main">
        {primaryNav.map((item) => (
          <a
            key={item.path}
            href={"#" + item.path}
            aria-label={item.label}
            aria-current={isCurrent(route, item.path) ? "page" : undefined}
          >
            <Icon name={item.icon} size={20} />
            {item.path === "/needs-you" && needsYou > 0 && <span className="dot" />}
          </a>
        ))}
        <a href="#/settings" aria-label="Settings" aria-current={route === "/settings" ? "page" : undefined}>
          <Icon name="cog-6-tooth" size={20} />
        </a>
      </nav>
    </>
  );
}
