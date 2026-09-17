import {
  ID_JAG_ASSERTION_TYPE,
  type VerifiedProviderIdentity,
  agentAuthError,
  verifyProviderIdJag,
} from "@opensesame/agent-protocols";
import { overlapCast } from "@opensesame/os-domain";
import { importJWK } from "jose";
import type { AppContext } from "../context.js";
import {
  jwksForProvider,
  providerAssertionIsAdvertised,
  trustedProviderFor,
} from "./agent-auth-id-jag-trust.js";
import {
  consumeAgentAuthMintBudget,
  fingerprintOf,
} from "./agent-auth-shared.js";

export async function verifyProviderAssertionRequest(
  ctx: AppContext,
  input: { assertionType: string; assertion: string },
  headers: { userAgent?: string; origin?: string },
): Promise<VerifiedProviderIdentity> {
  const cfg = ctx.config.agentAuth;
  if (!providerAssertionIsAdvertised(cfg)) {
    throw agentAuthError("identity_assertion_not_enabled", 400);
  }
  if (input.assertionType !== ID_JAG_ASSERTION_TYPE) {
    throw agentAuthError("invalid_request", 400, "unsupported assertion_type");
  }
  const now = ctx.clock();
  if (
    !consumeAgentAuthMintBudget(
      ctx.stores.agentAuthMints,
      fingerprintOf(headers),
      now.getTime(),
    )
  ) {
    throw agentAuthError("rate_limited", 429);
  }

  let issuerHint = "";
  try {
    const payloadB64 = input.assertion.split(".")[1];
    if (payloadB64) {
      const payload = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8"),
      ) as { iss?: unknown };
      if (typeof payload.iss === "string") issuerHint = payload.iss;
    }
  } catch {
    throw agentAuthError("invalid_grant", 400, "assertion is not a JWT");
  }
  const provider = trustedProviderFor(cfg, issuerHint);
  if (!provider) {
    throw agentAuthError(
      "issuer_not_enabled",
      400,
      "untrusted assertion issuer",
    );
  }
  const jwks = await jwksForProvider(provider);
  return await verifyProviderIdJag(input.assertion, {
    issuer: provider.issuer,
    audiences: provider.audiences,
    algorithms: provider.algorithms,
    maxAgeSeconds: provider.maxAgeSeconds,
    maxAuthAgeSeconds: provider.maxAuthAgeSeconds,
    now,
    getKey: async (header) => {
      const listed = jwks.keys;
      const match = header.kid
        ? listed.find((key) => key.kid === header.kid)
        : listed[0];
      if (!match) {
        throw agentAuthError("invalid_request", 400, "unknown assertion kid");
      }
      try {
        return await importJWK(overlapCast(match), header.alg ?? "ES256");
      } catch {
        throw agentAuthError(
          "invalid_request",
          400,
          "assertion key import failed",
        );
      }
    },
  });
}