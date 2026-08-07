import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export interface VerifiedIdentity {
  sub: string;
  iss: string;
  aud: string | string[];
  scope?: string;
  assurance?: string;
  tokenUse?: string;
  payload: JWTPayload;
  accessToken: string;
}

export interface OpenSesameVerifierConfig {
  issuer: string;
  audience: string | string[];
  /** Override JWKS URI (defaults to {issuer}/jwks). */
  jwksUri?: string;
  /** Inject local JWKS for tests. */
  jwks?: { keys: unknown[] };
  clockToleranceSeconds?: number;
  requiredScopes?: string[];
}

export interface OpenSesameVerifier {
  verifyAccessToken(token: string): Promise<VerifiedIdentity>;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

function asAudienceList(aud: string | string[]): string[] {
  return Array.isArray(aud) ? aud : [aud];
}

function hasRequiredScopes(scope: string | undefined, required: string[]): boolean {
  if (required.length === 0) return true;
  const have = new Set((scope ?? "").split(/\s+/u).filter(Boolean));
  return required.every((s) => have.has(s));
}

export function createOpenSesameVerifier(
  config: OpenSesameVerifierConfig,
): OpenSesameVerifier {
  const issuer = trimSlash(config.issuer);
  const audiences = asAudienceList(config.audience);

  const getKey: JWTVerifyGetKey = config.jwks
    ? createLocalJWKSet(config.jwks as Parameters<typeof createLocalJWKSet>[0])
    : createRemoteJWKSet(new URL(config.jwksUri ?? `${issuer}/jwks`));

  return {
    async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
      const verifyOptions =
        audiences.length === 1
          ? {
              issuer,
              audience: audiences[0]!,
              clockTolerance: config.clockToleranceSeconds ?? 5,
            }
          : {
              issuer,
              audience: audiences,
              clockTolerance: config.clockToleranceSeconds ?? 5,
            };

      const { payload } = await jwtVerify(token, getKey, verifyOptions);

      if (payload.sub === undefined || payload.sub === "") {
        throw new Error("Token missing sub");
      }
      if (payload.iss === undefined) {
        throw new Error("Token missing iss");
      }

      const tokenUse =
        typeof payload.token_use === "string"
          ? payload.token_use
          : typeof payload.typ === "string"
            ? payload.typ
            : undefined;
      if (tokenUse === "id" || tokenUse === "refresh") {
        throw new Error(`Unexpected token type: ${tokenUse}`);
      }

      const scope =
        typeof payload.scope === "string"
          ? payload.scope
          : typeof payload.scp === "string"
            ? payload.scp
            : Array.isArray(payload.scp)
              ? payload.scp.map(String).join(" ")
              : undefined;

      if (!hasRequiredScopes(scope, config.requiredScopes ?? [])) {
        throw new Error("Token missing required scopes");
      }

      const assurance =
        typeof payload.assurance === "string"
          ? payload.assurance
          : typeof payload["os:assurance"] === "string"
            ? (payload["os:assurance"] as string)
            : undefined;

      const identity: VerifiedIdentity = {
        sub: payload.sub,
        iss: payload.iss,
        aud: (payload.aud as string | string[]) ?? audiences[0]!,
        payload,
        accessToken: token,
      };
      if (scope !== undefined) identity.scope = scope;
      if (assurance !== undefined) identity.assurance = assurance;
      if (tokenUse !== undefined) identity.tokenUse = tokenUse;
      return identity;
    },
  };
}

export type { JWTPayload };
