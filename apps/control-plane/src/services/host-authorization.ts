import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { appendAuditEvent } from "@opensesame/audit";
import { issueTransactionChallenge } from "@opensesame/auth-upstream";
import { isString } from "@opensesame/os-domain";
import { type JWK, SignJWT, importJWK } from "jose";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { loopbackHost } from "../deployment-mode.js";
import { takeSecurityMap } from "../repos/durable-map.js";
import { webAuthnRpFromPublicUrl } from "../routes/approval-ceremony.js";

const opaque = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);
export const HostChallenge = z
  .object({
    challenge_id: opaque,
    challenge_digest: z.string().regex(/^[a-f0-9]{64}$/),
    host_audience: z.string().url().max(2048),
    organization_id: opaque,
    operation: z.enum(["browser.authenticate", "agent.browser.control"]),
    transition: z.enum(["handoff", "take", "release"]).nullable(),
    target_id: opaque,
    origin: z.string().url().max(2048),
    dpop_jkt: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
    expires_at: z.number().int().positive(),
  })
  .strict()
  .refine((value) =>
    value.operation === "browser.authenticate"
      ? value.transition === null
      : value.transition !== null,
  );
type Challenge = z.infer<typeof HostChallenge>;
export type HostAuthorizationPending = {
  principalId: string;
  challenge: Challenge;
  webauthnChallenge: string;
  transactionDigest: string;
  expiresAt: Date;
};

export function hostAuthorizationAudiences(
  env: NodeJS.ProcessEnv,
  production: boolean,
  publicUrl: string,
): string[] {
  const raw = env.OPENSESAME_HOST_AUTHORIZATION_AUDIENCES;
  if (raw === undefined) return [];
  const hostname = new URL(publicUrl).hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname))
    throw new Error(
      "Host authorization requires an Identity hostname for WebAuthn (use localhost for local development), not an IP literal",
    );
  if (!env.OPENSESAME_JWKS_JSON)
    throw new Error(
      "Host authorization requires configured persistent OIDC signing keys",
    );
  const values = raw.split(",");
  if (values.length > 32 || new Set(values).size !== values.length)
    throw new Error("Invalid OPENSESAME_HOST_AUTHORIZATION_AUDIENCES");
  return values.map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Invalid OPENSESAME_HOST_AUTHORIZATION_AUDIENCES");
    }
    if (
      (value !== url.href && value !== url.origin) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        (production || url.protocol !== "http:" || !loopbackHost(url.hostname)))
    )
      throw new Error("Invalid OPENSESAME_HOST_AUTHORIZATION_AUDIENCES");
    return value;
  });
}

export function hostSigningJwk(ctx: AppContext) {
  const keys = ctx.oauth.configuration.jwks?.keys.filter(
    (key: JWK) =>
      key.kty === "RSA" &&
      key.alg === "RS256" &&
      key.use === "sig" &&
      isString(key.kid) &&
      key.kid.length > 0 &&
      isString(key.d) &&
      isString(key.n) &&
      Buffer.from(key.n, "base64url").length >= 256,
  );
  if (keys?.length !== 1)
    throw new Error(
      "Host authorization requires one configured RS256 signing key",
    );
  const key: JWK | undefined = keys[0];
  if (!key) throw new Error("Host authorization signing key unavailable");
  return key;
}

export async function beginHostAuthorization(
  ctx: AppContext,
  principalId: string,
  challenge: Challenge,
) {
  const now = ctx.clock().getTime();
  const origin = new URL(challenge.origin);
  if (
    !ctx.hostAuthorizationAudiences.includes(challenge.host_audience) ||
    origin.origin !== challenge.origin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" &&
      (origin.protocol !== "http:" || !loopbackHost(origin.hostname))) ||
    challenge.expires_at * 1000 <= now ||
    challenge.expires_at * 1000 > now + 300_000
  )
    throw new Error("Host challenge refused");
  const membership = await ctx.stores.organizationMemberships.find(
    challenge.organization_id,
    principalId,
  );
  if (!membership) throw new Error("Host challenge refused");
  hostSigningJwk(ctx);
  const transactionDigest = createHash("sha256")
    .update(JSON.stringify({ principalId, ...challenge }))
    .digest("hex");
  const issued = await issueTransactionChallenge(
    ctx.passkeyChallenges,
    webAuthnRpFromPublicUrl(ctx.config.publicUrl),
    {
      principalId,
      transactionDigest,
      ttlMs: challenge.expires_at * 1000 - now,
    },
  );
  const authorizationId = randomUUID();
  // Namespace capacity is enforced by the durable implementation; local mode is bounded too.
  if (ctx.stores.hostAuthorizations instanceof Map) {
    for (const [key, row] of ctx.stores.hostAuthorizations)
      if (row.expiresAt.getTime() <= now)
        ctx.stores.hostAuthorizations.delete(key);
    if (ctx.stores.hostAuthorizations.size >= 1000)
      throw new Error("Host authorization capacity exceeded");
  }
  await ctx.stores.hostAuthorizations.set(authorizationId, {
    principalId,
    challenge,
    webauthnChallenge: issued.challenge,
    transactionDigest,
    expiresAt: new Date(challenge.expires_at * 1000),
  });
  return {
    authorization_id: authorizationId,
    challenge,
    options: issued.options,
  };
}

const encoded = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[A-Za-z0-9+/_=-]+$/);
export const HostAssertion = z
  .object({
    authorization_id: z.string().uuid(),
    credentialId: encoded,
    clientDataJSON: encoded,
    authenticatorData: encoded,
    signature: encoded,
  })
  .strict();

export async function completeHostAuthorization(
  ctx: AppContext,
  principalId: string,
  input: z.infer<typeof HostAssertion>,
) {
  const pending = await ctx.stores.hostAuthorizations.get(
    input.authorization_id,
  );
  if (
    !pending ||
    pending.principalId !== principalId ||
    pending.expiresAt.getTime() <= ctx.clock().getTime()
  )
    throw new Error("Host authorization refused");
  const clientData = z
    .object({ challenge: z.string() })
    .parse(
      JSON.parse(
        Buffer.from(input.clientDataJSON, "base64url").toString("utf8"),
      ),
    );
  const issued = await ctx.passkeyChallenges.peek(clientData.challenge);
  if (
    clientData.challenge !== pending.webauthnChallenge ||
    issued?.purpose !== "transaction" ||
    issued.principalId !== principalId ||
    issued.transactionDigest !== pending.transactionDigest
  )
    throw new Error("Host authorization refused");
  // Atomically spend the pending transaction before the verifier can have side effects.
  if (
    !(await takeSecurityMap(
      ctx.stores.hostAuthorizations,
      input.authorization_id,
    ))
  )
    throw new Error("Host authorization refused");
  const result = await ctx.hostAuthorizationPasskeys.verify({
    credentialId: input.credentialId,
    clientDataJSON: Buffer.from(input.clientDataJSON, "base64url"),
    authenticatorData: Buffer.from(input.authenticatorData, "base64url"),
    signature: Buffer.from(input.signature, "base64url"),
    expectedPurpose: "transaction",
  });
  if (!result.ok || result.principalId !== principalId)
    throw new Error("Host authorization refused");
  const membership = await ctx.stores.organizationMemberships.find(
    pending.challenge.organization_id,
    principalId,
  );
  const now = Math.floor(ctx.clock().getTime() / 1000);
  if (
    !membership ||
    now >= pending.challenge.expires_at ||
    !ctx.hostAuthorizationAudiences.includes(pending.challenge.host_audience)
  )
    throw new Error("Host authorization refused");
  const jwk = hostSigningJwk(ctx);
  const key = await importJWK(jwk, "RS256");
  const assertion = await new SignJWT({
    ...pending.challenge,
    organization_role: membership.role,
    auth_time: now,
    amr: ["webauthn"],
    assurance: "phishing_resistant",
  })
    .setProtectedHeader({
      typ: "host-authorization+jwt",
      alg: "RS256",
      kid: String(jwk.kid),
    })
    .setIssuer(ctx.config.issuer)
    .setAudience(pending.challenge.host_audience)
    .setSubject(principalId)
    .setIssuedAt(now)
    .setExpirationTime(Math.min(now + 300, pending.challenge.expires_at))
    .setJti(randomUUID())
    .sign(key);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "host.authorization.issued",
    principalId,
    actorType: "human",
    outcome: "succeeded",
    metadata: {
      challengeId: pending.challenge.challenge_id,
      challengeDigest: pending.challenge.challenge_digest,
      operation: pending.challenge.operation,
    },
  });
  return assertion;
}
