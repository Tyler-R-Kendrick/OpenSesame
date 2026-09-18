import { agentAuthError } from "@opensesame/agent-protocols";
import type { UnitOfWork } from "@opensesame/database";
import { assertSafeMetadataUrl } from "@opensesame/oauth-provider";
import {
  type JsonObject,
  overlapCast,
  isFunction,
} from "@opensesame/os-domain";
import type { AgentAuthTrustedProvider } from "../config.js";
import type { AppContext } from "../context.js";

export function providerAssertionIsAdvertised(
  cfg: AppContext["config"]["agentAuth"],
): boolean {
  return (
    cfg.enabled &&
    cfg.providerAssertionEnabled &&
    cfg.trustedProviders.some((provider) => provider.enabled)
  );
}

const providerReplayFallback = new Map<string, number>();

export async function consumeProviderReplay(
  ctx: AppContext,
  issuer: string,
  jti: string,
  expiresAt: Date,
  uow?: UnitOfWork,
): Promise<boolean> {
  const consume = ctx.repos.agentAuth.consumeProviderAssertionReplay;
  if (isFunction(consume)) {
    return consume(issuer, jti, expiresAt, uow);
  }
  const key = `${issuer}\0${jti}`;
  const now = Date.now();
  for (const [seen, exp] of providerReplayFallback) {
    if (exp <= now) providerReplayFallback.delete(seen);
  }
  if (providerReplayFallback.has(key)) return false;
  providerReplayFallback.set(key, expiresAt.getTime());
  return true;
}

export function trustedProviderFor(
  cfg: AppContext["config"]["agentAuth"],
  issuer: string,
): AgentAuthTrustedProvider | undefined {
  const normalized = issuer.replace(/\/+$/u, "");
  return cfg.trustedProviders.find(
    (provider) =>
      provider.enabled && provider.issuer.replace(/\/+$/u, "") === normalized,
  );
}

export type ProviderJwks = { keys: JsonObject[] };

export async function jwksForProvider(
  provider: AgentAuthTrustedProvider,
): Promise<ProviderJwks> {
  if (provider.jwks?.keys && provider.jwks.keys.length > 0) {
    return provider.jwks;
  }
  if (!provider.jwksUri) {
    throw agentAuthError("invalid_request", 400, "provider keys unavailable");
  }
  try {
    assertSafeMetadataUrl(provider.jwksUri);
  } catch {
    throw agentAuthError(
      "invalid_request",
      400,
      "provider jwks_uri is not safe",
    );
  }
  const response = await fetch(provider.jwksUri, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw agentAuthError("invalid_request", 400, "provider JWKS fetch failed");
  }
  const body = await response.text();
  if (body.length > 65_536) {
    throw agentAuthError("invalid_request", 400, "provider JWKS too large");
  }
  let parsed: { keys?: JsonObject[] };
  try {
    parsed = overlapCast(JSON.parse(body));
  } catch {
    throw agentAuthError("invalid_request", 400, "provider JWKS is not JSON");
  }
  if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw agentAuthError("invalid_request", 400, "provider JWKS has no keys");
  }
  return { keys: parsed.keys };
}
