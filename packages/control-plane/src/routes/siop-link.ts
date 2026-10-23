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

/** Challenge minting is authenticated but still cheap to loop. */
const CHALLENGE_WINDOW_MS = 10 * 60_000;
const CHALLENGES_PER_PRINCIPAL = 10;
const CHALLENGES_GLOBAL = 500;
const CHALLENGE_MAX_KEYS = 2048;
const CHALLENGE_GLOBAL_KEY = "__global__";
const challengeBudget = new Map<string, number[]>();

function consumeChallengeBudget(principalId: string, now: number): boolean {
  for (const [key, times] of challengeBudget) {
    const live = times.filter((at) => now - at < CHALLENGE_WINDOW_MS);
    if (live.length === 0) challengeBudget.delete(key);
    else if (live.length !== times.length) challengeBudget.set(key, live);
  }
  const global = challengeBudget.get(CHALLENGE_GLOBAL_KEY) ?? [];
  const key = `principal:${principalId}`;
  const mine = challengeBudget.get(key) ?? [];
  if (
    global.length >= CHALLENGES_GLOBAL ||
    mine.length >= CHALLENGES_PER_PRINCIPAL
  ) {
    return false;
  }
  global.push(now);
  mine.push(now);
  challengeBudget.set(CHALLENGE_GLOBAL_KEY, global);
  challengeBudget.set(key, mine);
  while (challengeBudget.size > CHALLENGE_MAX_KEYS) {
    const victim = [...challengeBudget.keys()].find(
      (candidate) => candidate !== CHALLENGE_GLOBAL_KEY,
    );
    if (victim === undefined) break;
    challengeBudget.delete(victim);
  }
  return true;
}

/** Test hook: the budget is process-global. */
export function resetSiopChallengeBudget(): void {
  challengeBudget.clear();
}

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
  if (!consumeChallengeBudget(principalId, ctx.clock().getTime())) {
    return c.json({ error: "rate_limited" }, 429);
  }
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
    // The thrown message can name a rejected parameter. Keep it in the log,
    // where an operator can correlate it, and answer the caller uniformly.
    ctx.log.warn(
      { err: error, principalId },
      "siop link challenge could not be created",
    );
    return c.json(
      { error: "invalid_request", hint: "invalid challenge parameters" },
      400,
    );
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
