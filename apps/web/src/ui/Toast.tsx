import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run(): void };
  /** The modal dialog open when it was shown: everything outside a modal dialog is inert, so it lives inside. */
  host?: HTMLDialogElement;
}
type Show = (text: string, action?: Toast["action"]) => void;
const ToastContext = createContext<Show>(() => undefined);

const canPop = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast>();
  const show = useCallback<Show>((text, action) => {
    const host = document.querySelector<HTMLDialogElement>("dialog[open]") ?? undefined;
    setToast({ id: Date.now(), text, ...(action ? { action } : {}), ...(host ? { host } : {}) });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), toast.action ? 7000 : 3500);
    // When its dialog closes, the toast moves out to the page.
    const out = () => setToast((current) => (current === toast ? { ...toast, host: undefined } : current));
    toast.host?.addEventListener("close", out);
    return () => {
      clearTimeout(timer);
      toast.host?.removeEventListener("close", out);
    };
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast &&
        withHost(
          toast.host,
          <div
            className="vc-toast"
            role="status"
            key={toast.id}
            // A popover joins the top layer when shown, so the toast sits above an open dialog and its backdrop.
            popover={canPop ? "manual" : undefined}
            ref={(node) => {
              if (node && canPop && !node.matches(":popover-open")) node.showPopover();
            }}
          >
            <span>{toast.text}</span>
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  toast.action?.run();
                  setToast(undefined);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>,
        )}
    </ToastContext.Provider>
  );
}

function withHost(host: HTMLDialogElement | undefined, node: ReactNode) {
  return host ? createPortal(node, host) : node;
}

export const useToast = () => useContext(ToastContext);
