/**
 * Hosted SIOP link routes (ADR 0117).
 */

import { isString, isTypeofObject, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import {
  type CreateSiopLinkChallengeInput,
  type LinkSiopInput,
  type SiopLinkChallenge,
  challengeIssuer,
  createSiopLinkChallenge,
  linkVerifiedSiopSubject,
} from "../services/siop-verify.js";
import { authenticatedPrincipalId } from "./organizations.js";

export const siopLinkRoutes = new Hono<{ Variables: Variables }>();

type SiopLinkErrorResponse = {
  error: string;
  code?: string;
};

siopLinkRoutes.post("/challenges", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const parsedBody = await c.req.json().catch(() => undefined);
  const body =
    parsedBody && isTypeofObject(parsedBody) && !Array.isArray(parsedBody)
      ? overlapCast(parsedBody)
      : {};
  const audience = isString(body.audience) ? body.audience.trim() : "";
  if (!audience || audience.length > 2048) {
    return c.json({ error: "invalid_request", hint: "audience required" }, 400);
  }
  const expectedIssuer = isString(body.expectedIssuer)
    ? body.expectedIssuer.trim()
    : undefined;
  const requireDynamicSiopMarker = body.requireDynamicSiopMarker === true;
  const challengeInput: CreateSiopLinkChallengeInput = {
    audience,
    requireDynamicSiopMarker,
  };
  if (expectedIssuer !== undefined) {
    challengeInput.expectedIssuer = expectedIssuer;
  }
  let challenge: SiopLinkChallenge;
  try {
    challenge = await createSiopLinkChallenge(ctx, principalId, challengeInput);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "invalid challenge parameters";
    return c.json({ error: "invalid_request", message }, 400);
  }
  return c.json(
    {
      challengeId: challenge.id,
      nonce: challenge.nonce,
      audience: challenge.audience,
      expectedIssuer: challengeIssuer(challenge),
      requireDynamicSiopMarker: challenge.profile.kind === "dynamic",
      expiresAt: new Date(challenge.expiresAt).toISOString(),
    },
    201,
  );
});

siopLinkRoutes.post("/link", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const parsedBody = await c.req.json().catch(() => undefined);
  const body =
    parsedBody && isTypeofObject(parsedBody) && !Array.isArray(parsedBody)
      ? overlapCast(parsedBody)
      : {};

  if (body.email !== undefined || body.emailNormalized !== undefined) {
    return c.json(
      {
        error: "email_link_refused",
        message: "SIOP links only by sub / JWK thumbprint (ADR 0117).",
      },
      400,
    );
  }

  const idToken = isString(body.id_token)
    ? body.id_token
    : isString(body.idToken)
      ? body.idToken
      : "";
  const challengeId = isString(body.challenge_id)
    ? body.challenge_id
    : isString(body.challengeId)
      ? body.challengeId
      : "";
  if (!idToken || !challengeId) {
    return c.json(
      {
        error: "invalid_request",
        hint: "id_token and challenge_id required",
      },
      400,
    );
  }

  const linkInput: LinkSiopInput = {
    principalId,
    idToken,
    challengeId,
  };
  const result = await linkVerifiedSiopSubject(ctx, linkInput, {
    correlationId: c.get("correlationId"),
  });

  if (!result.ok) {
    const status =
      result.error === "email_link_refused"
        ? 400
        : result.error === "identity_collision"
          ? 409
          : result.error === "challenge_principal_mismatch"
            ? 403
            : result.error === "verification_failed"
              ? 401
              : 400;
    if (result.code !== undefined) {
      return c.json(
        {
          error: result.error,
          code: result.code,
        } satisfies SiopLinkErrorResponse,
        status,
      );
    }
    return c.json(
      { error: result.error } satisfies SiopLinkErrorResponse,
      status,
    );
  }

  const recordedThumbprint = result.identity.metadata.jwk_thumbprint;
  const jwkThumbprint =
    isString(recordedThumbprint) && recordedThumbprint.length > 0
      ? recordedThumbprint
      : result.identity.subject;

  return c.json(
    {
      principalId: result.identity.principalId,
      alreadyLinked: result.alreadyLinked,
      link: {
        identityId: result.identity.id,
        siopSub: result.identity.subject,
        jwkThumbprint,
        issuer: result.identity.issuer,
        linkedAt: result.identity.linkedAt.toISOString(),
      },
    },
    result.alreadyLinked ? 200 : 201,
  );
});
