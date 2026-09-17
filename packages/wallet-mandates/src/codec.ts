import { type KeyLike, SignJWT, compactVerify } from "jose";
import { asClaims, malformedReason } from "./parse.js";
import {
  AP2_LOCAL_PROFILE,
  type MandateClaims,
  type MandateTrust,
  type MandateVerifyResult,
} from "./types.js";

const ALLOWED_ALG = "ES256";

export async function signMandate(
  claims: MandateClaims,
  privateKey: KeyLike,
  kid: string,
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALLOWED_ALG, kid, typ: "ap2-mandate+jwt" })
    .sign(privateKey);
}

function headerAlg(compact: string): MandateVerifyResult | "ok" {
  const headerPart = compact.split(".")[0];
  if (!headerPart) return { ok: false, reason: "signature_invalid" };
  try {
    const header = JSON.parse(
      Buffer.from(headerPart, "base64url").toString("utf8"),
    ) as { alg?: string };
    if (header.alg !== ALLOWED_ALG) {
      return { ok: false, reason: "alg_not_es256" };
    }
    return "ok";
  } catch {
    return { ok: false, reason: "signature_invalid" };
  }
}

async function verifiedPayload(
  compact: string,
  trust: MandateTrust,
): Promise<{ ok: true; payload: unknown } | MandateVerifyResult> {
  try {
    const result = await compactVerify(compact, async (header) => {
      const kid = header.kid;
      if (typeof kid !== "string") throw new Error("signature_invalid");
      const key = trust.jwks.get(kid);
      if (key === undefined) throw new Error("issuer_untrusted");
      return key;
    });
    return {
      ok: true,
      payload: JSON.parse(new TextDecoder().decode(result.payload)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "issuer_untrusted") {
      return { ok: false, reason: "issuer_untrusted" };
    }
    return { ok: false, reason: "signature_invalid" };
  }
}

function checkClaims(
  claims: MandateClaims,
  trust: MandateTrust,
  now: number,
  expectedAmount: string | undefined,
  spentJtis: ReadonlySet<string> | undefined,
): MandateVerifyResult {
  if (claims.iss !== trust.issuer) {
    return { ok: false, reason: "issuer_untrusted" };
  }
  if (claims.aud !== trust.audience) {
    return { ok: false, reason: "audience_mismatch" };
  }
  if (claims.exp <= now) return { ok: false, reason: "expired" };
  if (expectedAmount !== undefined && claims.amount !== expectedAmount) {
    return { ok: false, reason: "amount_mismatch" };
  }
  if (BigInt(claims.amount) > BigInt(claims.constraints.maxAmount)) {
    return { ok: false, reason: "amount_mismatch" };
  }
  if (spentJtis?.has(claims.jti)) {
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

export async function verifyMandate(input: {
  readonly compact: string;
  readonly trust: MandateTrust;
  readonly nowSeconds?: number;
  readonly expectedAmount?: string;
  readonly spentJtis?: ReadonlySet<string>;
}): Promise<MandateVerifyResult> {
  const alg = headerAlg(input.compact);
  if (alg !== "ok") return alg;
  const verified = await verifiedPayload(input.compact, input.trust);
  if (!verified.ok) return verified;
  const claims = asClaims(verified.payload);
  if (claims === null) {
    return { ok: false, reason: malformedReason(verified.payload) };
  }
  return checkClaims(
    claims,
    input.trust,
    input.nowSeconds ?? Math.floor(Date.now() / 1000),
    input.expectedAmount,
    input.spentJtis,
  );
}
