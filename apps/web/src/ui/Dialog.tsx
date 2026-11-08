import { useEffect, useRef } from "react";
import type { FormEvent, ReactNode } from "react";

// Native <dialog>: focus moves in and is trapped, Esc closes, focus returns to the trigger.
export function Dialog({
  open,
  title,
  lede,
  onClose,
  onSubmit,
  children,
  buttons,
}: {
  open: boolean;
  title: string;
  lede?: string;
  onClose(): void;
  onSubmit(): void;
  children: ReactNode;
  buttons: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const before = document.activeElement as HTMLElement | null;
      dialog.showModal?.();
      if (!dialog.showModal) dialog.setAttribute("open", "");
      return () => before?.focus?.();
    }
    if (!open && dialog.open) dialog.close?.();
  }, [open]);
  if (!open) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <dialog
      ref={ref}
      className="vc-dialog"
      aria-labelledby="vc-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <form
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
        }}
      >
        <h2 id="vc-dialog-title">{title}</h2>
        {lede && <p className="lede">{lede}</p>}
        {children}
        <div className="buttons">{buttons}</div>
      </form>
    </dialog>
  );
}
