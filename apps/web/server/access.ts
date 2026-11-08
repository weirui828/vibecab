import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// Browser access to the web host. The launch secret is printed once and is single use; redeeming it yields a
// session cookie. Any process or page on the machine could otherwise act as the person with admin scope.
export class Access {
  private launchSecret: Buffer | undefined = randomBytes(32);
  private readonly sessions = new Set<string>();
  cookieName = "vc_web";

  /** Cookies are shared across ports on 127.0.0.1, so the name carries the port. */
  bind(port: number): void {
    this.cookieName = "vc_web_" + port;
  }

  launchToken(): string {
    if (!this.launchSecret) throw new Error("The launch link was already used");
    return this.launchSecret.toString("base64url");
  }

  /** Returns a new session id if `candidate` is the unused launch secret. */
  redeem(candidate: string): string | undefined {
    const secret = this.launchSecret;
    if (!secret) return undefined;
    const given = Buffer.from(candidate, "base64url");
    if (given.length !== secret.length || !timingSafeEqual(given, secret)) return undefined;
    this.launchSecret = undefined;
    const session = randomBytes(32).toString("base64url");
    this.sessions.add(session);
    return session;
  }

  /** A fresh single-use launch link, for a second browser. Only the process that owns the host can ask. */
  renew(): string {
    this.launchSecret = randomBytes(32);
    return this.launchToken();
  }

  cookie(session: string): string {
    return `${this.cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
  }

  authorized(req: IncomingMessage): boolean {
    const header = req.headers.cookie;
    if (!header) return false;
    for (const part of header.split(";")) {
      const [name, value] = part.trim().split("=", 2);
      if (name === this.cookieName && value !== undefined && this.sessions.has(value)) return true;
    }
    return false;
  }
}

export function sameHost(req: IncomingMessage, port: number): boolean {
  return ["127.0.0.1:" + port, "localhost:" + port].includes(req.headers.host ?? "");
}

export function sameOrigin(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === "http://127.0.0.1:" + port || origin === "http://localhost:" + port;
}
