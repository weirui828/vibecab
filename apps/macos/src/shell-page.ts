// What the Mac shell says to the page it shows. The page is the web app, loaded from the web host inside this app;
// it has no preload and no IPC, so the shell reaches it only through these few scripts, and the page cannot reach
// the shell at all.

/** Goes to a page of the web app, e.g. "/settings" or "/s/<session id>". */
export function navigateScript(path: string): string {
  if (!/^\/[\w\-./~%]*$/.test(path)) throw new Error("Not a page of VibeCab: " + path);
  return `window.location.hash = ${JSON.stringify("#" + path)};`;
}

/** Tells the page about a menu or tray action; the page listens for `vibecab:<name>` on window. */
export function eventScript(name: "new-draft"): string {
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify("vibecab:" + name)}));`;
}

/** Marks the page as shown in the Mac window, so its styles leave room for the window buttons. */
export const macClassScript = `document.documentElement.classList.add("vc-mac");`;

/** Whether a URL is a page of the web host this window shows. Everything else stays out of the window. */
export function insideApp(url: string, appUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

/** Links the window may hand to the system's browser or mail app. */
export function external(url: string): boolean {
  return /^(https:|mailto:)/i.test(url);
}
