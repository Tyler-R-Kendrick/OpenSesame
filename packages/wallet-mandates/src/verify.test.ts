import { overlapCast } from "@opensesame/os-domain";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { signMandate, verifyMandate } from "./codec.js";
import { LocalMandateLedger } from "./ledger.js";
import {
  AP2_LOCAL_PROFILE,
  type MandateClaims,
  type MandateTrust,
} from "./types.js";

async function fixture() {
  const issuerKeys = await generateKeyPair("ES256", { extractable: true });
  const attackerKeys = await generateKeyPair("ES256", { extractable: true });
  const trust: MandateTrust = {
    issuer: "https://issuer.test.local",
    audience: "https://merchant.test.local",
    jwks: new Map([["iss-1", issuerKeys.publicKey]]),
  };
  const now = 1_800_000_000;
  const base = (overrides: Partial<MandateClaims> = {}): MandateClaims => ({
    iss: trust.issuer,
    aud: trust.audience,
    sub: "user-1",
    jti: "jti-1",
    iat: now,
    exp: now + 600,
    role: "payment",
    cartHash: "c".repeat(64),
    amount: "400",
    protection: "required",
    crit: ["constraints", "protection"],
    constraints: {
      maxAmount: "1000",
      currency: "TEST",
      recipient: "0xmerchant",
      assetFingerprint: "eip155:31337/0xtoken",
      protection: "required",
      recurrence: false,
    },
    ...overrides,
  });
  return { issuerKeys, attackerKeys, trust, now, base };
}

describe("AP2/UCP local mandate verifier", () => {
  it("accepts ES256 fixture-local checkout", async () => {
    const { issuerKeys, trust, now, base } = await fixture();
    const result = await verifyMandate({
      compact: await signMandate(base(), issuerKeys.privateKey, "iss-1"),
      trust,
      nowSeconds: now,
      expectedAmount: "400",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile).toBe(AP2_LOCAL_PROFILE);
      expect(result.productionEnabled).toBe(false);
      expect(result.trust).toBe("fixture-local");
    }
  });

  it("rejects constraint stripping", async () => {
    const { issuerKeys, trust, now, base } = await fixture();
    const strippedPayload = { ...base(), constraints: undefined };
    const stripped: MandateClaims = overlapCast(strippedPayload);
    const result = await verifyMandate({
      compact: await signMandate(stripped, issuerKeys.privateKey, "iss-1"),
      trust,
      nowSeconds: now,
    });
    expect(result).toEqual({ ok: false, reason: "constraint_stripped" });
  });

  it("rejects issuer substitution and unknown kid", async () => {
    const { attackerKeys, trust, now, base } = await fixture();
    const swapped = await verifyMandate({
      compact: await signMandate(base(), attackerKeys.privateKey, "iss-1"),
      trust,
      nowSeconds: now,
    });
    expect(swapped.ok).toBe(false);
    const unknown = await verifyMandate({
      compact: await signMandate(base(), attackerKeys.privateKey, "evil"),
      trust,
      nowSeconds: now,
    });
    expect(unknown).toEqual({ ok: false, reason: "issuer_untrusted" });
  });

  it("rejects protection downgrade and alg none", async () => {
    const { issuerKeys, trust, now, base } = await fixture();
    const downgraded: MandateClaims = overlapCast({
      ...base(),
      protection: "none",
    });
    const down = await verifyMandate({
      compact: await signMandate(
        downgraded,
        issuerKeys.privateKey,
        "iss-1",
      ),
      trust,
      nowSeconds: now,
    });
    expect(down).toEqual({ ok: false, reason: "protection_downgrade" });
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const body = Buffer.from(JSON.stringify(base())).toString("base64url");
    const none = await verifyMandate({
      compact: `${header}.${body}.`,
      trust,
      nowSeconds: now,
    });
    expect(none).toEqual({ ok: false, reason: "alg_not_es256" });
  });

  it("stateful ledger refuses overspend of individually valid mandates", async () => {
    const { issuerKeys, trust, now, base } = await fixture();
    const ledger = new LocalMandateLedger(1000n);
    const v1 = await verifyMandate({
      compact: await signMandate(
        base({ jti: "a", amount: "700" }),
        issuerKeys.privateKey,
        "iss-1",
      ),
      trust,
      nowSeconds: now,
    });
    const v2 = await verifyMandate({
      compact: await signMandate(
        base({ jti: "b", amount: "400" }),
        issuerKeys.privateKey,
        "iss-1",
      ),
      trust,
      nowSeconds: now,
    });
    expect(v1.ok && v2.ok).toBe(true);
    if (!v1.ok || !v2.ok) return;
    expect(ledger.fulfill(v1.claims)).toEqual({ ok: true, remaining: "300" });
    expect(ledger.fulfill(v2.claims)).toEqual({
      ok: false,
      reason: "allowance_exceeded",
    });
  });
});
