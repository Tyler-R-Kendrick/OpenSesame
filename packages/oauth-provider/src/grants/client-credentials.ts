import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { errors } from "oidc-provider";
import type { JwtReplayCache } from "./replay-cache.js";

export const CLIENT_CREDENTIALS_FEATURE = { enabled: true } as const;

/** Documented max lifetime for the supported JWT/service-token profile (ADV-19). */
export const SERVICE_ACCESS_TOKEN_MAX_SECONDS = 3600;

const SECRET_AUTH_METHODS = new Set([
  "client_secret_basic",
  "client_secret_post",
  "client_secret_jwt",
]);

export type ClientAuthMetadata = {
  grant_types?: string[];
  token_endpoint_auth_method?: string;
  client_secret?: string;
};

type InvalidatableClient = ClientAuthMetadata & {
  invalidate?: (message: string) => void;
};

export function isPublicClient(metadata: ClientAuthMetadata): boolean {
  const method = metadata.token_endpoint_auth_method;
  if (method === "none") return true;
  if (!method || SECRET_AUTH_METHODS.has(method)) {
    return !metadata.client_secret;
  }
  return false;
}

export function assertConfidentialClientCredentials(
  metadata: InvalidatableClient,
): void {
  const grants = metadata.grant_types ?? [];
  if (!grants.includes("client_credentials")) return;
  if (!isPublicClient(metadata)) return;
  const message = "public clients cannot use the client_credentials grant";
  if (metadata.invalidate) {
    metadata.invalidate(message);
    return;
  }
  throw new Error(message);
}

/**
 * extraClientMetadata hook: public clients (`token_endpoint_auth_method:
 * none` or no secret) may not register `client_credentials`.
 */
export type ClientCredentialsExtraMetadata = {
  properties: string[];
  validator: (
    ctx: BoundaryValue,
    key: string,
    value: BoundaryValue,
    metadata: BoundaryValue,
  ) => void;
};

export function clientCredentialsExtraMetadata(): ClientCredentialsExtraMetadata {
  return {
    // Sentinel so oidc-provider invokes the validator for every client,
    // including static registrations. The property is never persisted.
    properties: ["os_cc_fence"],
    validator(_ctx, key, _value, metadata) {
      if (key !== "os_cc_fence") return;
      assertConfidentialClientCredentials(overlapCast(metadata));
    },
  };
}

/**
 * Belt-and-suspenders jti tracking on top of oidc-provider ReplayDetection.
 * Signature verification already ran when this is invoked.
 */
export function createJwtClientAuthReplayGuard(cache: JwtReplayCache) {
  return async (
    _ctx: BoundaryValue,
    claims: JsonObject,
    _header: JsonObject,
    _client: BoundaryValue,
  ): Promise<void> => {
    const jti = claims.jti;
    const iss = claims.iss;
    const exp = claims.exp;
    if (!isString(jti) || !isString(iss) || !isNumber(exp)) return;
    const expiresAtMs = (exp + 5) * 1000;
    if (!(await cache.remember(iss, jti, expiresAtMs))) {
      throw new errors.InvalidClientAuth(
        "client assertion tokens must only be used once",
      );
    }
  };
}
