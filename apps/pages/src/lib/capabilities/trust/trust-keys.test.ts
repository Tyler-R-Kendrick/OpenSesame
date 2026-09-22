import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type PolicySigningKey,
  generatePolicySigningKey,
  signPolicyKeyRotation,
} from "./sign.js";
import {
  type PolicyKeyRotation,
  jwkThumbprintHex,
  keyFingerprint,
  policyPublicJwk,
  rotatePolicyKey,
} from "./trust-keys.js";

const INSTANCE = "fixture-family";
const NOW = "2026-09-22T12:00:00.000Z";

let current: PolicySigningKey;
let next: PolicySigningKey;
let attacker: PolicySigningKey;

function mutate<T>(base: PolicyKeyRotation, patch: T): BoundaryValue {
  // SAFETY: tests deliberately produce a hostile rotation document.
  const doc: BoundaryValue = overlapCast({ ...base, ...patch });
  return doc;
}

describe("policy keys and rotation (S03, TRUST-07)", () => {
  beforeAll(async () => {
    current = await generatePolicySigningKey();
    next = await generatePolicySigningKey();
    attacker = await generatePolicySigningKey();
  });

  it("accepts only public P-256 JWKs", async () => {
    expect(policyPublicJwk(current.publicJwk)).toEqual(current.publicJwk);
    expect(
      policyPublicJwk({ ...current.publicJwk, alg: "ES256", use: "sig" }),
    ).not.toBeNull();
    expect(
      policyPublicJwk({ ...current.publicJwk, d: "private-part" }),
    ).toBeNull();
    expect(policyPublicJwk({ ...current.publicJwk, crv: "P-384" })).toBeNull();
    expect(policyPublicJwk({ ...current.publicJwk, alg: "HS256" })).toBeNull();
    expect(policyPublicJwk({ kty: "oct", k: "secret" })).toBeNull();
    expect(policyPublicJwk(null)).toBeNull();
    const thumbprint = await jwkThumbprintHex(current.publicJwk);
    expect(thumbprint).toMatch(/^[0-9a-f]{64}$/);
    expect(current.kid).toBe(thumbprint);
    expect(keyFingerprint(thumbprint)).toBe(`sha256:${thumbprint}`);
  });

  it("accepts a rotation signed by the trusted key and binds the new kid to its key", async () => {
    const rotation = await signPolicyKeyRotation(current, {
      instanceId: INSTANCE,
      next,
      retire: false,
    });
    const result = await rotatePolicyKey(
      { [current.kid]: current.publicJwk },
      rotation,
      {
        instanceId: INSTANCE,
        now: NOW,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.keys).sort()).toEqual(
      [current.kid, next.kid].sort(),
    );
    expect(result.fingerprint).toBe(keyFingerprint(next.kid));
    const retiring = await signPolicyKeyRotation(current, {
      instanceId: INSTANCE,
      next,
      retire: true,
    });
    const retired = await rotatePolicyKey(
      { [current.kid]: current.publicJwk },
      retiring,
      {
        instanceId: INSTANCE,
        now: NOW,
      },
    );
    expect(retired.ok && Object.keys(retired.keys)).toEqual([next.kid]);
  });

  it("refuses rotations the trusted key did not authorize", async () => {
    const trusted = { [current.kid]: current.publicJwk };
    const opts = { instanceId: INSTANCE, now: NOW };
    const byAttacker = await signPolicyKeyRotation(attacker, {
      instanceId: INSTANCE,
      next,
      retire: false,
    });
    expect(await rotatePolicyKey(trusted, byAttacker, opts)).toEqual({
      ok: false,
      reason: "unknown-signer",
    });
    expect(
      await rotatePolicyKey(
        trusted,
        mutate(byAttacker, { signedBy: current.kid }),
        opts,
      ),
    ).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    const selfSigned = await signPolicyKeyRotation(attacker, {
      instanceId: INSTANCE,
      next: attacker,
      retire: false,
    });
    expect(await rotatePolicyKey(trusted, selfSigned, opts)).toEqual({
      ok: false,
      reason: "self-signed",
    });
    const good = await signPolicyKeyRotation(current, {
      instanceId: INSTANCE,
      next,
      retire: false,
    });
    expect(
      await rotatePolicyKey(
        trusted,
        mutate(good, { key: attacker.publicJwk }),
        opts,
      ),
    ).toEqual({
      ok: false,
      reason: "kid-mismatch",
    });
    expect(
      await rotatePolicyKey(trusted, good, { ...opts, instanceId: "other" }),
    ).toEqual({
      ok: false,
      reason: "wrong-instance",
    });
    expect(
      await rotatePolicyKey(trusted, mutate(good, { retire: "yes" }), opts),
    ).toEqual({
      ok: false,
      reason: "malformed-rotation",
    });
    const future = await signPolicyKeyRotation(current, {
      instanceId: INSTANCE,
      next,
      retire: false,
      notBefore: "2026-10-01T00:00:00.000Z",
    });
    expect(await rotatePolicyKey(trusted, future, opts)).toEqual({
      ok: false,
      reason: "not-yet-valid",
    });
  });
});
