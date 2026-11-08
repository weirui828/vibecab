import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon, IconButton } from "@wei/design-system";

export interface MenuItem {
  label: string;
  onSelect(): void;
  tone?: "danger";
  separatorBefore?: boolean;
}

// A small action menu: opens under its trigger, arrow keys move, Esc and outside clicks close, focus returns.
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false),
    id = useId(),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector("button")?.focus();
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    const buttons = [...(list.current?.querySelectorAll("button") ?? [])],
      index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "Tab") setOpen(false);
  };
  return (
    <div ref={root} style={{ position: "relative" }} onKeyDown={onKey}>
      <IconButton
        ref={trigger}
        className="vc-menu-trigger"
        variant="ghost"
        size="md"
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        icon={<Icon name="ellipsis-horizontal" />}
        onClick={() => setOpen((value) => !value)}
      />
      {open && (
        <div ref={list} id={id} className="vc-menu" role="menu" style={{ right: 0, top: "calc(100% + 4px)" }}>
          {items.map((item) => (
            <div key={item.label} role="none">
              {item.separatorBefore && <hr />}
              <button
                type="button"
                role="menuitem"
                data-tone={item.tone}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
