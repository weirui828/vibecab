export interface TokenCredential {
  kind: "token";
  secret: string;
  transport: "http" | "cli" | "mcp";
}

const trustedHostBrand: unique symbol = Symbol("trusted-host");
export interface TrustedHostCredential {
  readonly kind: "trusted_host";
  readonly scope: "read" | "collaborate" | "admin";
  readonly [trustedHostBrand]: true;
}

export type CallAuth = TokenCredential | TrustedHostCredential;
export interface CallMetadata {
  contractVersion: string;
  requestId: string;
}

export function mintTrustedHostCredential(scope: TrustedHostCredential["scope"]): TrustedHostCredential {
  return Object.freeze({ kind: "trusted_host", scope, [trustedHostBrand]: true as const });
}
