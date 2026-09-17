import { SignJWT, compactVerify, type KeyLike } from "jose";
import {
  AP2_LOCAL_PROFILE,
  type MandateClaims,
  type MandateTrust,
  type MandateVerifyResult,
} from "./types.js";

const ALLOWED_ALG = "ES256";

function asClaims(payload: unknown): MandateClaims | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.iss !== "string" ||
    typeof p.aud !== "string" ||
    typeof p.sub !== "string" ||
    typeof p.jti !== "string" ||
    typeof p.iat !== "number" ||
    typeof p.exp !== "number" ||
    (p.role !== "cart" && p.role !== "payment") ||
    typeof p.cartHash !== "string" ||
    typeof p.amount !== "string" ||
    p.protection !== "required"
  ) {
    return null;
  }
  const c = p.constraints as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return null;
  if (
    typeof c.maxAmount !== "string" ||
    typeof c.currency !== "string" ||
    typeof c.recipient !== "string" ||
    typeof c.assetFingerprint !== "string" ||
    c.protection !== "required" ||
    c.recurrence !== false
  ) {
    return null;
  }
  const crit = p.crit;
  if (
    !Array.isArray(crit) ||
    !crit.includes("constraints") ||
    !crit.includes("protection")
  ) {
    return null;
  }
  return {
    iss: p.iss,
    aud: p.aud,
    sub: p.sub,
    jti: p.jti,
    iat: p.iat,
    exp: p.exp,
    role: p.role,
    cartHash: p.cartHash,
    amount: p.amount,
    protection: "required",
    crit: ["constraints", "protection"],
    constraints: {
      maxAmount: c.maxAmount,
      currency: c.currency,
      recipient: c.recipient,
      assetFingerprint: c.assetFingerprint,
      protection: "required",
      recurrence: false,
    },
  };
}

export async function signMandate(
  claims: MandateClaims,
  privateKey: KeyLike,
  kid: string,
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALLOWED_ALG, kid, typ: "ap2-mandate+jwt" })
    .sign(privateKey);
}

export async function verifyMandate(input: {
  readonly compact: string;
  readonly trust: MandateTrust;
  readonly nowSeconds?: number;
  readonly expectedAmount?: string;
  readonly spentJtis?: ReadonlySet<string>;
}): Promise<MandateVerifyResult> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const headerPart = input.compact.split(".")[0];
  if (!headerPart) return { ok: false, reason: "signature_invalid" };
  try {
    const header = JSON.parse(
      Buffer.from(headerPart, "base64url").toString("utf8"),
    ) as { alg?: string };
    if (header.alg !== ALLOWED_ALG) {
      return { ok: false, reason: "alg_not_es256" };
    }
  } catch {
    return { ok: false, reason: "signature_invalid" };
  }
  let payload: unknown;
  try {
    const result = await compactVerify(input.compact, async (header) => {
      const kid = header.kid;
      if (typeof kid !== "string") throw new Error("signature_invalid");
      const key = input.trust.jwks.get(kid);
      if (key === undefined) throw new Error("issuer_untrusted");
      return key;
    });
    payload = JSON.parse(new TextDecoder().decode(result.payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "issuer_untrusted") {
      return { ok: false, reason: "issuer_untrusted" };
    }
    return { ok: false, reason: "signature_invalid" };
  }
  const claims = asClaims(payload);
  if (claims === null) {
    const raw = payload as Record<string, unknown> | null;
    if (raw && (raw.protection === "optional" || raw.protection === "none")) {
      return { ok: false, reason: "protection_downgrade" };
    }
    if (raw && raw.constraints === undefined) {
      return { ok: false, reason: "constraint_stripped" };
    }
    return { ok: false, reason: "critical_missing" };
  }
  if (claims.iss !== input.trust.issuer) {
    return { ok: false, reason: "issuer_untrusted" };
  }
  if (claims.aud !== input.trust.audience) {
    return { ok: false, reason: "audience_mismatch" };
  }
  if (claims.exp <= now) return { ok: false, reason: "expired" };
  if (
    input.expectedAmount !== undefined &&
    claims.amount !== input.expectedAmount
  ) {
    return { ok: false, reason: "amount_mismatch" };
  }
  if (BigInt(claims.amount) > BigInt(claims.constraints.maxAmount)) {
    return { ok: false, reason: "amount_mismatch" };
  }
  if (input.spentJtis?.has(claims.jti)) {
    return { ok: false, reason: "duplicate_jti" };
  }
  return {
    ok: true,
    claims,
    profile: AP2_LOCAL_PROFILE,
    productionEnabled: false,
    trust: "fixture-local",
  };
}
