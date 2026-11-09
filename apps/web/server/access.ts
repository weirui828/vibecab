import type { IncomingMessage } from "node:http";

// What keeps other websites out of VibeCab. There is no browser sign-in: the web host listens on 127.0.0.1 only,
// and programs running as this user are trusted (they could read the app token anyway). Websites open in the
// browser are not, and these two checks stop them.

/**
 * DNS rebinding defense: the request must be addressed to this host (127.0.0.1 or localhost, this port), so a
 * site whose domain was switched to point at 127.0.0.1 is refused.
 */
export function sameHost(req: IncomingMessage, port: number): boolean {
  return ["127.0.0.1:" + port, "localhost:" + port].includes(req.headers.host ?? "");
}

/**
 * CSRF (cross-site request forgery) defense: a request that names its origin must come from VibeCab's own pages,
 * on this port. Browsers always send Origin on cross-site POSTs, and every action is a POST, so a page on another
 * site (or another local app on another port) cannot act here. A request without Origin is a plain page load.
 */
export function sameOrigin(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === "http://127.0.0.1:" + port || origin === "http://localhost:" + port;
}
