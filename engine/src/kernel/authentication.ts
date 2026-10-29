import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CONTRACT_VERSION, fail } from "../../../contract/src/index.js";
import type { CallContext } from "../../../contract/src/index.js";
import type { CallAuth, CallMetadata, TrustedHostCredential } from "../auth.js";
import { mintTrustedHostCredential } from "../auth.js";
import type { Clock, IdGenerator } from "../dependencies.js";
import type { Repository, StoredAccessToken } from "../storage/repository.js";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

export class Authentication {
  private readonly trustedCredentials = new WeakSet<object>();
  private readonly failures = new Map<"http" | "cli" | "mcp", number[]>();
  private hmacKey = "";

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly readMetadata: <T>(value: unknown) => T,
  ) {}

  configureKey(key: string): void {
    this.hmacKey = key;
  }

  mintTrustedHost(scope: TrustedHostCredential["scope"]): TrustedHostCredential {
    const credential = mintTrustedHostCredential(scope);
    this.trustedCredentials.add(credential);
    return credential;
  }

  resolve(auth: CallAuth, rawMetadata: CallMetadata, repository: Repository): CallContext {
    const metadata = this.readMetadata<CallMetadata>(rawMetadata);
    let context: CallContext;
    if (typeof auth === "object" && auth !== null && this.trustedCredentials.has(auth)) {
      const scope = Reflect.get(auth, "scope");
      if (scope !== "read" && scope !== "collaborate" && scope !== "admin")
        fail("unauthenticated", "Invalid credentials");
      context = {
        contractVersion: metadata.contractVersion,
        principal: { kind: "human" },
        channel: "in_process",
        scope,
        requestId: metadata.requestId,
      };
    } else {
      const kind = field(auth, "kind"),
        secret = field(auth, "secret"),
        transport = field(auth, "transport");
      if (
        kind !== "token" ||
        typeof secret !== "string" ||
        (transport !== "http" && transport !== "cli" && transport !== "mcp")
      )
        return this.failedAuthentication("http");
      const now = Date.parse(this.clock.now()),
        cutoff = now - 60_000,
        recent = (this.failures.get(transport) ?? []).filter((timestamp) => timestamp > cutoff);
      this.failures.set(transport, recent);
      if (recent.length >= 10) fail("rate_limited", "Too many invalid access tokens; retry later");
      const supplied = createHmac("sha256", this.hmacKey).update(secret).digest();
      let matched: StoredAccessToken | undefined;
      for (const token of repository.accessTokens()) {
        const candidate = Buffer.from(token.secretHash, "hex"),
          equal = candidate.length === supplied.length && timingSafeEqual(candidate, supplied);
        if (equal) matched = token;
      }
      if (!matched || matched.revokedAt || matched.channel !== transport) {
        recent.push(now);
        this.failures.set(transport, recent);
        fail("unauthenticated", "Invalid access token");
      }
      context = {
        contractVersion: metadata.contractVersion,
        principal: { kind: "human" },
        channel: transport,
        scope: matched.scope,
        requestId: metadata.requestId,
      };
    }
    if (context.contractVersion !== CONTRACT_VERSION) fail("unsupported", "Contract version is not supported");
    return context;
  }

  hash(secret: string): string {
    return createHmac("sha256", this.hmacKey).update(secret).digest("hex");
  }

  private failedAuthentication(transport: "http" | "cli" | "mcp"): never {
    const now = Date.parse(this.clock.now()),
      cutoff = now - 60_000,
      recent = (this.failures.get(transport) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= 10) fail("rate_limited", "Too many invalid access tokens; retry later");
    recent.push(now);
    this.failures.set(transport, recent);
    fail("unauthenticated", "Invalid access token");
  }

  async migrateLegacyFile(workspace: string, repository: Repository): Promise<void> {
    const path = join(workspace, "access-tokens.json");
    let decoded: unknown;
    try {
      decoded = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      fail("unavailable", "Legacy access token file could not be read");
    }
    const secret = field(decoded, "admin");
    if (typeof secret !== "string" || secret.length < 16) fail("unavailable", "Legacy access token file is invalid");
    const token: StoredAccessToken = {
      tokenId: this.ids.next("token_"),
      name: "Migrated HTTP admin token",
      channel: "http",
      scope: "admin",
      secretHash: this.hash(secret),
      createdAt: this.clock.now(),
    };
    if (
      !repository.accessTokens().some((stored) => stored.secretHash === token.secretHash && stored.channel === "http")
    )
      repository.transaction(() => repository.createAccessToken(token));
    await unlink(path);
  }
}

export function randomAccessTokenKey(): string {
  return randomBytes(32).toString("hex");
}
