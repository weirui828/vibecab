import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, it } from "vitest";

// Chrome's popover rules, which jsdom lacks: showing a popover that is not in the page throws.
const globals = ["window", "document", "navigator", "HTMLElement", "Node", "MutationObserver"] as const;
let dom: JSDOM;
let tl: typeof import("@testing-library/react");
beforeAll(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  for (const key of globals) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  const proto = dom.window.HTMLElement.prototype as HTMLElement & { showPopover(): void };
  proto.showPopover = function (this: HTMLElement) {
    if (!this.isConnected)
      throw new dom.window.DOMException("Invalid on disconnected popover elements.", "InvalidStateError");
    this.dataset.popoverOpen = "true";
  };
  tl = await import("@testing-library/react");
});
afterAll(() => {
  tl?.cleanup();
  dom?.window.close();
  for (const key of globals) Reflect.deleteProperty(globalThis, key);
});

it("a toast shown from a dialog that then goes away moves to the page instead of crashing the app", async () => {
  const { ToastProvider, useToast } = await import("../src/ui/Toast.js");
  const { useState } = await import("react");
  function Saver() {
    const toast = useToast(),
      [open, setOpen] = useState(true);
    // Like the Snapshot dialog: say it is saved, then close and leave the page in the same click.
    return open ? (
      <dialog open>
        <button
          type="button"
          onClick={() => {
            toast("Snapshot saved");
            setOpen(false);
          }}
        >
          Save
        </button>
      </dialog>
    ) : (
      <p>Back on the page</p>
    );
  }
  tl.render(
    <ToastProvider>
      <Saver />
    </ToastProvider>,
  );
  tl.fireEvent.click(tl.screen.getByRole("button", { name: "Save" }));
  expect(await tl.screen.findByText("Back on the page")).toBeTruthy();
  // jsdom hides every popover (it has no :popover-open), so look past that and check it was shown.
  const toast = await tl.screen.findByRole("status", { hidden: true });
  expect(toast.textContent).toBe("Snapshot saved");
  expect(toast.isConnected).toBe(true);
  expect(toast.dataset.popoverOpen).toBe("true");
});
