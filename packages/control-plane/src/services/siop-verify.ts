/**
 * Hosted SIOP → principal link (ADR 0117).
 *
 * Verifies Self-Issued ID Tokens via `@opensesame/siop-v2` and records an
 * explicit cryptographic binding. Email is never a join key.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import { ConflictError } from "@opensesame/database";
import type { ExternalIdentity } from "@opensesame/os-domain";
import { isString } from "@opensesame/os-domain";
import {
  type VerifiedSelfIssuedIdToken,
  type VerifySelfIssuedIdTokenInput,
  bodyOffersEmailJoin,
  challengeIssuerFromProfile,
  ecP256JwkThumbprint,
  isSiopV2Error,
  resolveSiopLinkProfile,
  verifySelfIssuedIdToken,
} from "@opensesame/siop-v2";
import type { AppContext } from "../context.js";
import { takeSecurityMap } from "../repos/durable-map.js";
import type { SiopLinkChallenge } from "../state.js";

export type { SiopLinkChallenge } from "../state.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type CreateSiopLinkChallengeInput = {
  audience: string;
  expectedIssuer?: string;
  requireDynamicSiopMarker?: boolean;
};

export type LinkSiopInput = {
  principalId: string;
  idToken: string;
  challengeId: string;
  /** Rejected when present — SIOP never joins on email (ADR 0117). */
  email?: unknown;
  emailNormalized?: unknown;
};

export type LinkSiopResult =
  | { ok: true; alreadyLinked: boolean; identity: ExternalIdentity }
  | {
      ok: false;
      error:
        | "email_link_refused"
        | "challenge_not_found"
        | "challenge_expired"
        | "challenge_principal_mismatch"
        | "verification_failed"
        | "identity_collision";
      code?: string;
    };

export function challengeIssuer(challenge: SiopLinkChallenge): string {
  return challengeIssuerFromProfile(challenge.profile);
}

export async function createSiopLinkChallenge(
  ctx: AppContext,
  principalId: string,
  input: CreateSiopLinkChallengeInput,
): Promise<SiopLinkChallenge> {
  const audience = input.audience.trim();
  if (!audience) {
    throw new Error("audience required");
  }
  const nowMs = ctx.clock().getTime();
  const challenge: SiopLinkChallenge = {
    id: `siopc_${randomBytes(16).toString("base64url")}`,
    principalId,
    nonce: randomBytes(24).toString("base64url"),
    audience,
    profile: resolveSiopLinkProfile(input),
    expiresAt: nowMs + CHALLENGE_TTL_MS,
  };
  await ctx.stores.siopLinkChallenges.set(challenge.id, challenge);
  return challenge;
}

async function restoreSiopLinkChallenge(
  ctx: AppContext,
  challengeId: string,
  challenge: SiopLinkChallenge,
): Promise<void> {
  await ctx.stores.siopLinkChallenges.set(challengeId, challenge);
}

export async function verifySiopIdToken(
  input: VerifySelfIssuedIdTokenInput,
): Promise<VerifiedSelfIssuedIdToken> {
  return verifySelfIssuedIdToken(input);
}

export async function linkVerifiedSiopSubject(
  ctx: AppContext,
  input: LinkSiopInput,
  options?: { correlationId?: string },
): Promise<LinkSiopResult> {
  if (bodyOffersEmailJoin(input)) {
    return { ok: false, error: "email_link_refused" };
  }
  if (!isString(input.idToken) || input.idToken.length === 0) {
    return {
      ok: false,
      error: "verification_failed",
      code: "malformed_id_token",
    };
  }

  const nowMs = ctx.clock().getTime();
  // Take first so concurrent /link calls cannot both mint from one challenge.
  const challenge = await takeSecurityMap(
    ctx.stores.siopLinkChallenges,
    input.challengeId,
  );
  if (!challenge) {
    return { ok: false, error: "challenge_not_found" };
  }
  if (challenge.expiresAt <= nowMs) {
    return { ok: false, error: "challenge_expired" };
  }
  if (challenge.principalId !== input.principalId) {
    await restoreSiopLinkChallenge(ctx, input.challengeId, challenge);
    return { ok: false, error: "challenge_principal_mismatch" };
  }

  let verified: VerifiedSelfIssuedIdToken;
  try {
    verified = await verifySiopIdToken({
      idToken: input.idToken,
      expectedAudience: challenge.audience,
      expectedNonce: challenge.nonce,
      profile: challenge.profile,
      nowSeconds: Math.floor(nowMs / 1000),
    });
  } catch (error) {
    await restoreSiopLinkChallenge(ctx, input.challengeId, challenge);
    const code =
      error instanceof Error && isSiopV2Error(error)
        ? error.code
        : "signature_invalid";
    return { ok: false, error: "verification_failed", code };
  }

  const thumbprint = await ecP256JwkThumbprint(verified.subJwk);
  if (thumbprint !== verified.sub) {
    await restoreSiopLinkChallenge(ctx, input.challengeId, challenge);
    return {
      ok: false,
      error: "verification_failed",
      code: "subject_mismatch",
    };
  }

  const existing = await ctx.repos.externalIdentities.findByTuple({
    kind: "siop",
    issuer: verified.iss,
    subject: verified.sub,
  });
  if (existing) {
    if (existing.principalId === input.principalId) {
      return { ok: true, alreadyLinked: true, identity: existing };
    }
    return { ok: false, error: "identity_collision" };
  }

  const identity: ExternalIdentity = {
    id: `xid_${randomUUID()}`,
    principalId: input.principalId,
    kind: "siop",
    issuer: verified.iss,
    subject: verified.sub,
    assurance: "verified",
    linkedAt: ctx.clock(),
    metadata: { jwk_thumbprint: thumbprint },
  };

  try {
    await ctx.repos.externalIdentities.create(identity);
  } catch (error) {
    if (error instanceof ConflictError) {
      const peer = await ctx.repos.externalIdentities.findByTuple({
        kind: "siop",
        issuer: verified.iss,
        subject: verified.sub,
      });
      if (peer?.principalId === input.principalId) {
        return { ok: true, alreadyLinked: true, identity: peer };
      }
      return { ok: false, error: "identity_collision" };
    }
    throw error;
  }

  const auditEvent = {
    eventType: "principal.siop_link" as const,
    outcome: "succeeded" as const,
    principalId: input.principalId,
    metadata: {
      action: "siop.link",
      issuer: verified.iss,
      siop_sub: verified.sub,
      jwk_thumbprint: thumbprint,
    },
  };
  if (options?.correlationId !== undefined) {
    await appendAuditEvent(ctx.repos.auditEvents, {
      ...auditEvent,
      correlationId: options.correlationId,
    });
  } else {
    await appendAuditEvent(ctx.repos.auditEvents, auditEvent);
  }

  return { ok: true, alreadyLinked: false, identity };
}
