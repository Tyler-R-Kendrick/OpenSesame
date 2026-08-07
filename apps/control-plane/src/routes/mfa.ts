import { Hono } from "hono";
import { createHmac, randomBytes } from "node:crypto";
import type { Variables } from "../middleware/context.js";
import { requirePrincipal } from "../middleware/auth.js";

/** DEV/test TOTP: HMAC-SHA1 truncated to 6 digits (RFC 6238-style). */
function totpCode(secretB64: string, step = 30, digits = 6, at = Date.now()): string {
  const key = Buffer.from(secretB64, "base64");
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const otp = bin % 10 ** digits;
  return otp.toString().padStart(digits, "0");
}

export const mfaRoutes = new Hono<{ Variables: Variables }>();

mfaRoutes.post("/passkey/register", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const body = await c.req.json<{
    credentialId: string;
    publicKey: string;
    counter?: number;
  }>();
  if (!body.credentialId || !body.publicKey) {
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

mfaRoutes.post("/passkey/assert", async (c) => {
  const ctx = c.get("ctx");
  if (!ctx.config.allowDevDefaults) {
    return c.json(
      {
        ok: false,
        error: "passkey_verifier_unconfigured",
        hint: "Wire a real WebAuthn verifier; stub assert is disabled outside allowDevDefaults",
      },
      503,
    );
  }
  const body = await c.req.json<{
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  }>();
  if (!body.credentialId || !body.signature) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const result = await ctx.passkeys.verify({
    credentialId: body.credentialId,
    clientDataJSON: Buffer.from(body.clientDataJSON ?? "", "base64"),
    authenticatorData: Buffer.from(body.authenticatorData ?? "", "base64"),
    signature: Buffer.from(body.signature, "base64"),
  });
  if (!result.ok) return c.json({ ok: false }, 401);
  return c.json({ ok: true, principalId: result.principalId });
});

mfaRoutes.post("/totp/enroll", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const secret = randomBytes(20);
  const secretB64 = secret.toString("base64");
  ctx.stores.totpSecrets.set(principalId, secretB64);
  const otpauthUrl = `otpauth://totp/OpenSesame:${encodeURIComponent(principalId)}?secret=${secret.toString("hex")}&issuer=OpenSesame`;
  return c.json({
    ok: true,
    secret: secretB64,
    otpauthUrl,
    note: "DEV: verify with /v1/mfa/totp/verify using the computed code",
  });
});

mfaRoutes.post("/totp/verify", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const body = await c.req.json<{ code: string; principalId?: string }>();
  if (body.principalId && body.principalId !== principalId) {
    return c.json({ ok: false, error: "principal_mismatch" }, 403);
  }
  const secret = ctx.stores.totpSecrets.get(principalId);
  if (!secret) return c.json({ ok: false, error: "not_enrolled" }, 404);
  const expected = totpCode(secret);
  const ok = body.code === expected;
  return c.json({ ok }, ok ? 200 : 401);
});

export { totpCode };
