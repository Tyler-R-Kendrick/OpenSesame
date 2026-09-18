import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { normalizeIssuer } from "./interactions/registry.js";

export type AgentAuthTrustedProvider = {
  issuer: string;
  enabled: boolean;
  audiences: string[];
  algorithms: string[];
  maxAgeSeconds: number;
  maxAuthAgeSeconds: number;
  jwks?: { keys: JsonObject[] };
  jwksUri?: string;
};

export type AgentAuthEnvConfig = {
  enabled: boolean;
  anonymousEnabled: boolean;
  serviceAuthEnabled: boolean;
  providerAssertionEnabled: boolean;
  eventsEnabled: boolean;
  registrationTtlMs: number;
  claimAttemptTtlMs: number;
  assertionTtlMs: number;
  accessTokenTtlMs: number;
  pollIntervalSeconds: number;
  maxUserCodeAttempts: number;
  maxLiveAnonymous: number;
  preClaimScopes: string[];
  postClaimScopes: string[];
  resourceScopes: string[];
  trustedProviders: AgentAuthTrustedProvider[];
};

export function truthy(v: string | undefined): boolean {
  return v === "true" || v === "1";
}

/** Like {@link truthy}, but an unset value means on. Only `false`/`0` opt out. */
function truthyDefaultOn(v: string | undefined): boolean {
  if (v === undefined || v.trim() === "") return true;
  return !(v === "false" || v === "0");
}

function stringList(value: BoundaryValue, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items: string[] = [];
  for (const item of value) {
    if (isString(item)) items.push(item);
  }
  return items.length > 0 ? items : fallback;
}

function positiveNumber(value: BoundaryValue, fallback: number): number {
  return isNumber(value) && value > 0 ? value : fallback;
}

function parseTrustedProviderRow(
  row: BoundaryValue,
  defaultAudience: string,
): AgentAuthTrustedProvider | undefined {
  if (!isJsonObject(row)) return undefined;
  const rec = row;
  if (!isString(rec.issuer) || rec.issuer.length === 0) return undefined;
  const fallbackAudiences = [defaultAudience];
  const slashed = defaultAudience.endsWith("/")
    ? defaultAudience
    : `${defaultAudience}/`;
  if (!fallbackAudiences.includes(slashed)) fallbackAudiences.push(slashed);
  const maxAuthAge = positiveNumber(
    overlapCast(rec.maxAuthAgeSeconds),
    positiveNumber(overlapCast(rec.idJagMaxAuthAgeSeconds), 3600),
  );
  const provider: AgentAuthTrustedProvider = {
    issuer: normalizeIssuer(rec.issuer),
    enabled: rec.enabled !== false,
    audiences: stringList(overlapCast(rec.audiences), fallbackAudiences),
    algorithms: stringList(overlapCast(rec.algorithms), ["ES256", "RS256"]),
    maxAgeSeconds: positiveNumber(overlapCast(rec.maxAgeSeconds), 300),
    maxAuthAgeSeconds: maxAuthAge,
  };
  if (isJsonObject(rec.jwks) && Array.isArray(rec.jwks.keys)) {
    provider.jwks = { keys: rec.jwks.keys.filter(isJsonObject) };
  }
  if (isString(rec.jwksUri)) provider.jwksUri = rec.jwksUri;
  return provider;
}

export function parseTrustedAgentProviders(
  raw: string | undefined,
  defaultAudience: string,
): AgentAuthTrustedProvider[] {
  if (!raw || raw.trim() === "") return [];
  let parsed: BoundaryValue;
  try {
    parsed = overlapCast(JSON.parse(raw));
  } catch {
    throw new Error(
      "OPENSESAME_AGENT_AUTH_TRUSTED_PROVIDERS_JSON is not valid JSON",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "OPENSESAME_AGENT_AUTH_TRUSTED_PROVIDERS_JSON must be a JSON array",
    );
  }
  const out: AgentAuthTrustedProvider[] = [];
  for (const row of parsed) {
    const provider = parseTrustedProviderRow(overlapCast(row), defaultAudience);
    if (provider) out.push(provider);
  }
  return out;
}

export function loadAgentAuthFromEnv(
  env: NodeJS.ProcessEnv,
  issuer: string,
): AgentAuthEnvConfig {
  return {
    enabled: truthyDefaultOn(env.OPENSESAME_AGENT_AUTH_ENABLED),
    anonymousEnabled: truthyDefaultOn(
      env.OPENSESAME_AGENT_AUTH_ANONYMOUS_ENABLED,
    ),
    serviceAuthEnabled: truthyDefaultOn(
      env.OPENSESAME_AGENT_AUTH_SERVICE_AUTH_ENABLED,
    ),
    providerAssertionEnabled: truthy(
      env.OPENSESAME_AGENT_AUTH_PROVIDER_ASSERTION_ENABLED,
    ),
    eventsEnabled: truthy(env.OPENSESAME_AGENT_AUTH_EVENTS_ENABLED),
    registrationTtlMs: Number(
      env.OPENSESAME_AGENT_AUTH_REGISTRATION_TTL_MS ?? String(86_400_000),
    ),
    claimAttemptTtlMs: Number(
      env.OPENSESAME_AGENT_AUTH_CLAIM_ATTEMPT_TTL_MS ?? String(600_000),
    ),
    assertionTtlMs: Number(
      env.OPENSESAME_AGENT_AUTH_ASSERTION_TTL_MS ?? String(3_600_000),
    ),
    accessTokenTtlMs: Number(
      env.OPENSESAME_AGENT_AUTH_ACCESS_TOKEN_TTL_MS ?? String(3_600_000),
    ),
    pollIntervalSeconds: Number(
      env.OPENSESAME_AGENT_AUTH_POLL_INTERVAL_SECONDS ?? "5",
    ),
    maxUserCodeAttempts: Number(
      env.OPENSESAME_AGENT_AUTH_MAX_USER_CODE_ATTEMPTS ?? "5",
    ),
    maxLiveAnonymous: Number(
      env.OPENSESAME_AGENT_AUTH_MAX_LIVE_ANONYMOUS ?? "1024",
    ),
    preClaimScopes: ["resource:read", "resource:create:temporary"],
    postClaimScopes: [
      "resource:read",
      "resource:create:temporary",
      "project:create:temporary",
      "claim:create",
    ],
    resourceScopes: [
      "resource:read",
      "resource:create:temporary",
      "project:create:temporary",
      "claim:create",
    ],
    trustedProviders: parseTrustedAgentProviders(
      env.OPENSESAME_AGENT_AUTH_TRUSTED_PROVIDERS_JSON,
      issuer,
    ),
  };
}
