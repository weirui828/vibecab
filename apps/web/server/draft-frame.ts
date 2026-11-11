// The page an HTML Draft is shown in. It is an address of its own so that it can carry its own, stricter policy:
// a frame filled from `srcdoc` would inherit the app's policy, which forbids the inline scripts such a file has.
// The policy is the safety boundary: no network at all, no forms, and `sandbox` gives the page an origin of its
// own even if someone opens this address directly, so nothing in a Draft can reach VibeCab or the engine.

export const draftFramePath = "/draft-frame";

export const draftFramePolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

/** An empty page that waits for the app to hand it the Draft, once, and then becomes it. */
export const draftFrameShell = [
  '<!doctype html><meta charset="utf-8"><title>Draft</title><script>',
  'addEventListener("message", function fill(event) {',
  "  if (event.source !== parent || !event.data || event.data.vcDraft !== true) return;",
  '  removeEventListener("message", fill);',
  "  document.open();",
  "  document.write(String(event.data.html));",
  "  document.close();",
  "});",
  'parent.postMessage({ vcFrame: "ready" }, "*");',
  "</script>",
].join("\n");
