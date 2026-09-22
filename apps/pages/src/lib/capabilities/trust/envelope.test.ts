import type { InstanceCapabilityPolicy } from "@opensesame/capability-composition";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { beforeAll, describe, expect, it } from "vitest";
import { FAMILY_POLICY } from "../__tests__/plan-fixtures.js";
import {
  type SignedPolicyEnvelope,
  readPolicyEnvelope,
  verifyPolicyEnvelope,
} from "./envelope.js";
import {
  type PolicySigningKey,
  generatePolicySigningKey,
  signPolicyEnvelope,
} from "./sign.js";
import type { TrustedKeySet } from "./trust-keys.js";

const ORIGIN = "https://vault.example.test";
const NOW = "2026-09-22T12:00:00.000Z";

let signer: PolicySigningKey;
let attacker: PolicySigningKey;
let trustedKeys: TrustedKeySet;
let envelope: SignedPolicyEnvelope;

function mutate<T>(base: SignedPolicyEnvelope, patch: T): BoundaryValue {
  // SAFETY: tests deliberately produce a malformed or hostile document.
  const doc: BoundaryValue = overlapCast({ ...base, ...patch });
  return doc;
}

async function verify(
  candidate: BoundaryValue | SignedPolicyEnvelope,
  options: Partial<Parameters<typeof verifyPolicyEnvelope>[1]> = {},
) {
  return verifyPolicyEnvelope(candidate, {
    trustedKeys,
    origin: ORIGIN,
    now: NOW,
    ...options,
  });
}

describe("verifyPolicyEnvelope (S03)", () => {
  beforeAll(async () => {
    signer = await generatePolicySigningKey();
    attacker = await generatePolicySigningKey();
    trustedKeys = { [signer.kid]: signer.publicJwk };
    envelope = await signPolicyEnvelope(signer, {
      payload: FAMILY_POLICY,
      notBefore: "2026-09-01T00:00:00.000Z",
      expires: "2027-01-01T00:00:00.000Z",
      allowedOrigins: [ORIGIN],
    });
  });

  it("verifies a well-formed envelope and hands back the payload for parsing", async () => {
    const result = await verify(envelope);
    expect(result).toMatchObject({
      ok: true,
      kid: signer.kid,
      revision: FAMILY_POLICY.revision,
      payloadDigest: envelope.payloadDigest,
    });
    if (result.ok) expect(result.policy).toEqual(FAMILY_POLICY);
    expect(readPolicyEnvelope(envelope)?.kid).toBe(signer.kid);
  });

  it("TRUST-03: algorithm confusion — an envelope claiming HS256 is refused before any key is used", async () => {
    expect(await verify(mutate(envelope, { alg: "HS256" }))).toEqual({
      ok: false,
      reason: "unsupported-alg",
    });
    expect(await verify(mutate(envelope, { alg: "none" }))).toEqual({
      ok: false,
      reason: "unsupported-alg",
    });
  });

  it("TRUST-04: key substitution — an unknown kid or an attacker's key fails", async () => {
    const forged = await signPolicyEnvelope(attacker, {
      payload: FAMILY_POLICY,
    });
    expect(await verify(forged)).toEqual({ ok: false, reason: "unknown-kid" });
    // Attacker signs but claims the trusted kid.
    expect(await verify(mutate(forged, { kid: signer.kid }))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    // Attacker's key handed in under the trusted kid.
    expect(
      await verify(mutate(forged, { kid: signer.kid }), {
        trustedKeys: { [signer.kid]: attacker.publicJwk },
      }),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a tampered payload and a tampered header", async () => {
    const widened: InstanceCapabilityPolicy = {
      ...FAMILY_POLICY,
      capabilities: {
        ...FAMILY_POLICY.capabilities,
        optional: [
          ...FAMILY_POLICY.capabilities.optional,
          "telemetry.external",
        ],
        prohibited: [],
      },
    };
    expect(await verify(mutate(envelope, { payload: widened }))).toEqual({
      ok: false,
      reason: "payload-digest-mismatch",
    });
    expect(
      await verify(mutate(envelope, { expires: "2099-01-01T00:00:00.000Z" })),
    ).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(
      await verify(mutate(envelope, { allowedOrigins: undefined })),
    ).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("refuses malformed signatures and malformed envelopes", async () => {
    expect(
      await verify(mutate(envelope, { signature: "not base64url!" })),
    ).toEqual({
      ok: false,
      reason: "malformed-signature",
    });
    expect(await verify(mutate(envelope, { signature: "AAAA" }))).toEqual({
      ok: false,
      reason: "malformed-signature",
    });
    expect(await verify(mutate(envelope, { extra: 1 }))).toEqual({
      ok: false,
      reason: "malformed-envelope",
    });
    expect(
      await verify(mutate(envelope, { payloadDigest: "md5:abc" })),
    ).toEqual({
      ok: false,
      reason: "malformed-envelope",
    });
    expect(await verify("string")).toEqual({
      ok: false,
      reason: "malformed-envelope",
    });
    expect(await verify(null)).toEqual({
      ok: false,
      reason: "malformed-envelope",
    });
  });

  it("TRUST-08: wrong instance and wrong origin are refused", async () => {
    expect(
      await verify(envelope, { instanceId: "some-other-instance" }),
    ).toEqual({
      ok: false,
      reason: "wrong-instance",
    });
    const other = await signPolicyEnvelope(signer, {
      payload: { ...FAMILY_POLICY, instanceId: "fixture-other" },
    });
    // Header says one instance, payload another.
    expect(
      await verify(mutate(other, { instanceId: FAMILY_POLICY.instanceId })),
    ).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(
      await verify(envelope, { origin: "https://evil.example.test" }),
    ).toEqual({
      ok: false,
      reason: "origin-not-allowed",
    });
    const anywhere = await signPolicyEnvelope(signer, {
      payload: FAMILY_POLICY,
    });
    expect(
      (await verify(anywhere, { origin: "https://elsewhere.test" })).ok,
    ).toBe(true);
  });

  it("TRUST-09: validity is judged by the supplied clock, never Date.now()", async () => {
    expect(await verify(envelope, { now: "2026-08-31T23:59:59.000Z" })).toEqual(
      {
        ok: false,
        reason: "not-yet-valid",
      },
    );
    expect(await verify(envelope, { now: "2027-01-01T00:00:00.000Z" })).toEqual(
      {
        ok: false,
        reason: "expired",
      },
    );
    expect(await verify(envelope, { now: "yesterday" })).toEqual({
      ok: false,
      reason: "malformed-envelope",
    });
    expect(
      (await verify(envelope, { now: "2026-12-31T23:59:59.000Z" })).ok,
    ).toBe(true);
  });
});
