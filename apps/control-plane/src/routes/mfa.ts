import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  issueAuthenticationChallenge,
  issueRegistrationChallenge,
  verifyRegistrationAttestation,
} from "@opensesame/auth-upstream";
import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { MailerNotConfiguredError } from "../services/mailer.js";
import { authenticatedPrincipalId } from "./organizations.js";

/** Minimal WebAuthn registration response shape (SimpleWebAuthn JSON). */
type RegistrationResponseBody = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
  clientExtensionResults: JsonObject;
  authenticatorAttachment?: string;
};

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 base32, unpadded. The Key URI Format requires the `secret`
 * parameter in base32; authenticator apps base32-decode it verbatim, so any
 * other encoding silently derives a different key.
 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

interface MfaDenial {
  eventType: string;
  reason: string;
  principalId?: string;
  correlationId?: string;
  targetType?: string;
  targetId?: string;
}

/** DEV/test TOTP: HMAC-SHA1 truncated to 6 digits (RFC 6238-style). */
function totpCode(
  secretB64: string,
  step = 30,
  digits = 6,
  at = Date.now(),
): string {
  const key = Buffer.from(secretB64, "base64");
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = (hmac.at(-1) ?? 0) & 0x0f;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  const otp = bin % 10 ** digits;
  return otp.toString().padStart(digits, "0");
}

function totpCodesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function rpFromConfig(publicUrl: string) {
  let hostname = "localhost";
  try {
    hostname = new URL(publicUrl).hostname;
  } catch {
    /* keep default */
  }
  return { rpID: hostname, origin: publicUrl.replace(/\/$/, "") };
}

/**
 * A six-digit code is 10^6 guesses; a passkey assertion is not guessable but its
 * verification is not free. Both get the same small fence.
 */
const MAX_MFA_FAILURES = 5;
const MAX_MFA_FENCE_ENTRIES = 4096;
const MFA_ANON_WINDOW_MS = 60_000;
const MFA_ANON_MAX = 20;
const MFA_ANON_GLOBAL_MAX = 200;
const MFA_ANON_FENCE_ENTRIES = 4096;
const MAX_PASSKEY_FIELD_LENGTH = 16 * 1024;

function pruneMfaFailures(map: Map<string, number>): void {
  if (map.size <= MAX_MFA_FENCE_ENTRIES) return;
  const overflow = map.size - MAX_MFA_FENCE_ENTRIES;
  const keys = [...map.keys()].slice(0, overflow);
  for (const key of keys) map.delete(key);
}

function clientFingerprint(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  return createHash("sha256")
    .update(c.req.header("user-agent") ?? "")
    .update("|")
    .update(c.req.header("origin") ?? c.req.header("x-forwarded-for") ?? "")
    .digest("hex")
    .slice(0, 16);
}

function consumeAnonymousMfaBudget(
  map: Map<string, number[]>,
  fingerprint: string,
  now: number,
): boolean {
  for (const [key, values] of map) {
    const live = values.filter((at) => now - at < MFA_ANON_WINDOW_MS);
    if (live.length === 0) map.delete(key);
    else if (live.length !== values.length) map.set(key, live);
  }
  const global = map.get("__global__") ?? [];
  const client = map.get(fingerprint) ?? [];
  if (global.length >= MFA_ANON_GLOBAL_MAX || client.length >= MFA_ANON_MAX) {
    return false;
  }
  global.push(now);
  client.push(now);
  map.set("__global__", global);
  map.set(fingerprint, client);
  while (map.size > MFA_ANON_FENCE_ENTRIES) {
    const victim = [...map.keys()].find((key) => !key.startsWith("__"));
    if (victim === undefined) break;
    map.delete(victim);
  }
  return true;
}

function shouldAuditAnonymousDenial(
  map: Map<string, number[]>,
  now: number,
): boolean {
  const last = map.get("__audit__")?.[0];
  if (last !== undefined && now - last < MFA_ANON_WINDOW_MS) return false;
  map.set("__audit__", [now]);
  return true;
}

/**
 * Record a refused factor.
 *
 * Almost every audit event in this service is a success, which is the one shape
 * of trail that cannot show an attack: five failed codes followed by one success
 * reads as a single login. A denial is the event worth keeping.
 */
async function auditMfaDenial(
  ctx: AppContext,
  input: MfaDenial,
): Promise<void> {
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: input.eventType,
    outcome: "denied",
    ...(input.principalId !== undefined
      ? { principalId: input.principalId }
      : undefined),
    ...(input.correlationId !== undefined
      ? { correlationId: input.correlationId }
      : undefined),
    ...(input.targetType !== undefined
      ? { targetType: input.targetType }
      : undefined),
    ...(input.targetId !== undefined
      ? { targetId: input.targetId }
      : undefined),
    metadata: { action: input.eventType, reason: input.reason },
  });
}

export const mfaRoutes = new Hono<{ Variables: Variables }>();

/** Issue a one-time WebAuthn registration challenge (required in production). */
mfaRoutes.post(
  "/passkey/registration-options",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const rp = rpFromConfig(ctx.config.publicUrl);
    const { challenge, options } = await issueRegistrationChallenge(
      ctx.passkeyChallenges,
      rp,
      { principalId },
    );
    return c.json({ ok: true, challenge, options });
  },
);

/**
 * Register a passkey.
 * - Dev (`allowDevDefaults`): accepts raw credentialId/publicKey stubs.
 * - Production: requires a RegistrationResponseJSON verified against a prior
 *   `/passkey/registration-options` challenge (attestation ceremony).
 */
mfaRoutes.post("/passkey/register", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const body = await c.req.json<
    | {
        credentialId: string;
        publicKey: string;
        counter?: number;
      }
    | { response: RegistrationResponseBody }
  >();

  if (!ctx.config.allowDevDefaults) {
    if (!("response" in body) || !body.response) {
      return c.json(
        {
          error: "registration_attestation_required",
          hint: "POST /v1/mfa/passkey/registration-options then submit response",
        },
        400,
      );
    }
    const rp = rpFromConfig(ctx.config.publicUrl);
    const verified = await verifyRegistrationAttestation(
      ctx.passkeyChallenges,
      rp,
      overlapCast(body.response),
      principalId,
    );
    if (!verified) {
      return c.json({ error: "registration_verification_failed" }, 401);
    }
    const cred = await ctx.passkeys.register(principalId, {
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      counter: verified.counter,
    });
    return c.json({
      ok: true,
      credentialId: cred.credentialId,
      principalId: cred.principalId,
    });
  }

  if (!("credentialId" in body) || !body.credentialId || !body.publicKey) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const cred = await ctx.passkeys.register(principalId, {
    credentialId: body.credentialId,
    publicKey: Buffer.from(body.publicKey, "base64"),
    counter: body.counter ?? 0,
  });
  return c.json({
    ok: true,
    credentialId: cred.credentialId,
    principalId: cred.principalId,
  });
});

/** Issue a one-time WebAuthn challenge (required for production assert). */
mfaRoutes.post(
  "/passkey/authentication-options",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const rp = rpFromConfig(ctx.config.publicUrl);
    const { challenge, options } = await issueAuthenticationChallenge(
      ctx.passkeyChallenges,
      rp,
      { principalId },
    );
    return c.json({ ok: true, challenge, options });
  },
);

mfaRoutes.post("/passkey/assert", async (c) => {
  const ctx = c.get("ctx");
  const now = ctx.clock().getTime();
  const fingerprint = clientFingerprint(c);
  if (!consumeAnonymousMfaBudget(ctx.stores.mfaAnon, fingerprint, now)) {
    return c.json({ ok: false, error: "rate_limited" }, 429);
  }
  const body = await c.req.json<{
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  }>();
  if (
    !body.credentialId ||
    !body.signature ||
    [
      body.credentialId,
      body.clientDataJSON,
      body.authenticatorData,
      body.signature,
    ].some(
      (value) => !isString(value) || value.length > MAX_PASSKEY_FIELD_LENGTH,
    )
  ) {
    return c.json({ error: "invalid_request" }, 400);
  }
  pruneMfaFailures(ctx.stores.mfaFailures);
  const credentialDigest = createHash("sha256")
    .update(body.credentialId)
    .digest("hex")
    .slice(0, 32);
  const fenceKey = `passkey:${credentialDigest}`;
  const prior = ctx.stores.mfaFailures.get(fenceKey) ?? 0;
  if (prior >= MAX_MFA_FAILURES) {
    if (shouldAuditAnonymousDenial(ctx.stores.mfaAnon, now)) {
      await auditMfaDenial(ctx, {
        eventType: "mfa.passkey.assert",
        reason: "too_many_attempts",
        correlationId: c.get("correlationId"),
        targetType: "passkey_digest",
        targetId: credentialDigest,
      });
    }
    return c.json({ ok: false, error: "too_many_attempts" }, 429);
  }
  ctx.stores.mfaFailures.set(fenceKey, prior + 1);
  const result = await ctx.passkeys.verify({
    credentialId: body.credentialId,
    clientDataJSON: Buffer.from(body.clientDataJSON ?? "", "base64"),
    authenticatorData: Buffer.from(body.authenticatorData ?? "", "base64"),
    signature: Buffer.from(body.signature, "base64"),
  });
  if (!result.ok) {
    if (shouldAuditAnonymousDenial(ctx.stores.mfaAnon, now)) {
      await auditMfaDenial(ctx, {
        eventType: "mfa.passkey.assert",
        reason: "assertion_failed",
        correlationId: c.get("correlationId"),
        targetType: "passkey_digest",
        targetId: credentialDigest,
      });
    }
    return c.json({ ok: false }, 401);
  }
  ctx.stores.mfaFailures.delete(fenceKey);
  return c.json({ ok: true, principalId: result.principalId });
});

/**
 * DEV/test TOTP only — not a production MFA factor.
 * Prefer WebAuthn passkeys (`/passkey/*`) when `allowDevDefaults` is false.
 */
mfaRoutes.post("/totp/enroll", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  if (!ctx.config.allowDevDefaults) {
    return c.json(
      {
        error: "totp_dev_only",
        hint: "Use /v1/mfa/passkey/registration-options for production MFA",
      },
      403,
    );
  }
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const secret = randomBytes(20);
  const secretB64 = secret.toString("base64");
  ctx.stores.totpSecrets.set(principalId, secretB64);
  const otpauthUrl = `otpauth://totp/OpenSesame:${encodeURIComponent(principalId)}?secret=${base32Encode(secret)}&issuer=OpenSesame`;
  return c.json({
    ok: true,
    secret: secretB64,
    otpauthUrl,
    note: "DEV: verify with /v1/mfa/totp/verify using the computed code",
  });
});

mfaRoutes.post("/totp/verify", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  if (!ctx.config.allowDevDefaults) {
    return c.json(
      {
        error: "totp_dev_only",
        hint: "Use /v1/mfa/passkey/assert for production MFA",
      },
      403,
    );
  }
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const body = await c.req.json<{ code: string; principalId?: string }>();
  if (body.principalId && body.principalId !== principalId) {
    return c.json({ ok: false, error: "principal_mismatch" }, 403);
  }
  const secret = ctx.stores.totpSecrets.get(principalId);
  if (!secret) return c.json({ ok: false, error: "not_enrolled" }, 404);
  const fenceKey = `totp:${principalId}`;
  const prior = ctx.stores.mfaFailures.get(fenceKey) ?? 0;
  if (prior >= MAX_MFA_FAILURES) {
    await auditMfaDenial(ctx, {
      eventType: "mfa.totp.verify",
      reason: "too_many_attempts",
      principalId,
      correlationId: c.get("correlationId"),
    });
    return c.json({ ok: false, error: "too_many_attempts" }, 429);
  }
  ctx.stores.mfaFailures.set(fenceKey, prior + 1);
  const expected = totpCode(secret);
  const ok = totpCodesEqual(body.code ?? "", expected);
  if (!ok) {
    await auditMfaDenial(ctx, {
      eventType: "mfa.totp.verify",
      reason: "bad_code",
      principalId,
      correlationId: c.get("correlationId"),
    });
    return c.json({ ok }, 401);
  }
  ctx.stores.mfaFailures.delete(fenceKey);
  return c.json({ ok }, 200);
});

export { totpCode };

/* ------------------------------------------------------------------ *
 * One-time codes by email or text — the fallback second step
 * ------------------------------------------------------------------ */

/**
 * A code sent out of band is the weakest second step this service offers,
 * and it is offered for one reason: the phone with the authenticator is
 * gone. NIST SP 800-63B calls PSTN delivery *restricted* and rules email
 * out for out-of-band authentication, so the client says that before
 * binding either, and the authenticator stays the first choice at unlock.
 * The service's part is narrow: send a six-digit code to an address the
 * caller names, remember only its hash, and answer yes or no once.
 */
const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
/** Live challenges one principal may hold at once — a send budget, not a fence. */
const CODE_MAX_LIVE = 5;
const CODE_DIGITS = 6;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;

type CodeChannel = "email" | "sms";

function codeChannelOf(value: string): CodeChannel | null {
  return value === "email" || value === "sms" ? value : null;
}

function codeHash(challengeId: string, code: string): string {
  return createHash("sha256")
    .update(challengeId)
    .update(":")
    .update(code)
    .digest("hex");
}

function randomCode(): string {
  // Rejection-sampled so every code is equally likely; a modulo over 2^32
  // would favour the low end by a part in four thousand.
  const max = 10 ** CODE_DIGITS;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  for (;;) {
    const n = randomBytes(4).readUInt32BE(0);
    if (n < limit) return String(n % max).padStart(CODE_DIGITS, "0");
  }
}

/**
 * What the client may show of an address: enough to recognise it, not
 * enough to reach it. `t•••@example.com`; `+1 ••• ••• 0142`.
 */
export function maskDestination(channel: CodeChannel, to: string): string {
  if (channel === "email") {
    const at = to.indexOf("@");
    return `${to.slice(0, 1)}•••${to.slice(at)}`;
  }
  const country = to.slice(0, to.length - 10 > 1 ? to.length - 10 : 2);
  return `${country} ••• ••• ${to.slice(-4)}`;
}

function pruneCodes(
  map: Map<string, import("../state.js").MfaCodeChallenge>,
  now: number,
): void {
  for (const [id, challenge] of map) {
    if (challenge.expiresAt <= now) map.delete(id);
  }
}

mfaRoutes.post("/code/send", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const body = overlapCast(await c.req.json().catch(() => ({})));
  const channel = codeChannelOf(isString(body.channel) ? body.channel : "");
  const to = isString(body.to) ? body.to.trim() : "";
  if (channel === null) {
    return c.json(
      {
        ok: false,
        error: "invalid_request",
        hint: "channel must be email or sms",
      },
      400,
    );
  }
  if (
    channel === "email"
      ? !EMAIL_RE.test(to) || to.length > 254
      : !E164_RE.test(to)
  ) {
    return c.json(
      {
        ok: false,
        error: "invalid_request",
        hint:
          channel === "email"
            ? "to must be an email address"
            : "to must be an E.164 number",
      },
      400,
    );
  }
  const now = ctx.clock().getTime();
  pruneCodes(ctx.stores.mfaCodes, now);
  const live = [...ctx.stores.mfaCodes.values()].filter(
    (entry) => entry.principalId === principalId,
  );
  if (live.length >= CODE_MAX_LIVE) {
    await auditMfaDenial(ctx, {
      eventType: "mfa.code.send",
      reason: "too_many_codes",
      principalId,
      correlationId: c.get("correlationId"),
    });
    return c.json({ ok: false, error: "too_many_codes" }, 429);
  }

  const code = randomCode();
  const text = `Your OpenSesame code is ${code}. It is good for 10 minutes. If you did not ask for it, someone has your key and is being asked for a second step; nothing opens without this code.`;
  if (channel === "email") {
    try {
      await ctx.mailer.send({
        to,
        subject: `${code} is your OpenSesame code`,
        text,
      });
    } catch (error) {
      if (error instanceof MailerNotConfiguredError) {
        return c.json({ ok: false, error: "mail_not_configured" }, 503);
      }
      throw error;
    }
  } else {
    if (!ctx.sms.isConfigured()) {
      return c.json({ ok: false, error: "sms_not_configured" }, 503);
    }
    // Hand-built rather than rendered: the adapter's `render` clamps every
    // notification to a bodyless "something is waiting", which is right for
    // an approval prompt and useless for a code. The code *is* the message;
    // the client disclosed what a leased number means before binding it.
    const outcome = await ctx.sms.deliver(
      {
        kind: "sms",
        confidentiality: "minimal",
        title: "OpenSesame",
        body: text,
      },
      { channel: "sms", e164: to },
    );
    if (outcome.status !== "delivered") {
      return c.json(
        { ok: false, error: "sms_delivery_failed", status: outcome.status },
        502,
      );
    }
  }

  const challengeId = `mfc_${randomBytes(12).toString("hex")}`;
  ctx.stores.mfaCodes.set(challengeId, {
    principalId,
    channel,
    to,
    codeHash: codeHash(challengeId, code),
    createdAt: now,
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
  });
  return c.json({
    ok: true,
    challengeId,
    channel,
    to: maskDestination(channel, to),
    expiresAt: new Date(now + CODE_TTL_MS).toISOString(),
  });
});

mfaRoutes.post("/code/verify", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const body = overlapCast(await c.req.json().catch(() => ({})));
  const challengeId = isString(body.challengeId) ? body.challengeId : "";
  const code = isString(body.code) ? body.code.replace(/\s/g, "") : "";
  const now = ctx.clock().getTime();
  pruneCodes(ctx.stores.mfaCodes, now);
  const challenge = ctx.stores.mfaCodes.get(challengeId);
  // An unknown, expired or foreign challenge answers exactly like a wrong
  // code: the response must not say which challenges exist for whom.
  if (!challenge || challenge.principalId !== principalId) {
    await auditMfaDenial(ctx, {
      eventType: "mfa.code.verify",
      reason: "unknown_challenge",
      principalId,
      correlationId: c.get("correlationId"),
    });
    return c.json({ ok: false, error: "invalid_code" }, 401);
  }
  challenge.attempts += 1;
  const expected = Buffer.from(challenge.codeHash, "hex");
  const given = Buffer.from(codeHash(challengeId, code), "hex");
  const matches =
    code.length === CODE_DIGITS && timingSafeEqual(expected, given);
  if (!matches) {
    const spent = challenge.attempts >= CODE_MAX_ATTEMPTS;
    if (spent) ctx.stores.mfaCodes.delete(challengeId);
    await auditMfaDenial(ctx, {
      eventType: "mfa.code.verify",
      reason: spent ? "too_many_attempts" : "wrong_code",
      principalId,
      correlationId: c.get("correlationId"),
    });
    return c.json(
      { ok: false, error: spent ? "challenge_spent" : "invalid_code" },
      401,
    );
  }
  ctx.stores.mfaCodes.delete(challengeId);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "mfa.code.verify",
    outcome: "succeeded",
    principalId,
    correlationId: c.get("correlationId"),
    metadata: { action: "mfa.code.verify", channel: challenge.channel },
  });
  return c.json({
    ok: true,
    channel: challenge.channel,
    to: maskDestination(challenge.channel, challenge.to),
  });
});
