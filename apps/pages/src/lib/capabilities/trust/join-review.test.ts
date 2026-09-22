import { FIXTURE_CATALOG, FIXTURE_DISTRIBUTION } from "@opensesame/capability-composition";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { FAMILY_POLICY } from "../__tests__/plan-fixtures.js";
import { previewJoinDocument } from "./join-review.js";
import { generatePolicySigningKey, signPolicyEnvelope } from "./sign.js";
import { keyFingerprint } from "./trust-keys.js";

function doc(value: Record<string, BoundaryValue>): BoundaryValue {
  // SAFETY: tests hand the preview an arbitrary document on purpose.
  const out: BoundaryValue = overlapCast(value);
  return out;
}

describe("previewJoinDocument (S03, TRUST-02/07)", () => {
  it("previews a bare policy: known ids placed, unknown ids listed as absent", async () => {
    const policy = {
      ...FAMILY_POLICY,
      capabilities: {
        ...FAMILY_POLICY.capabilities,
        required: ["identity.federation", "enterprise.ca-administration"],
        optional: [...FAMILY_POLICY.capabilities.optional, "not.in-this-catalog"],
      },
    };
    const preview = await previewJoinDocument(doc(policy), FIXTURE_DISTRIBUTION, FIXTURE_CATALOG);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.instanceId).toBe(FAMILY_POLICY.instanceId);
    expect(preview.revision).toBe(FAMILY_POLICY.revision);
    expect(preview.signed).toBe(false);
    expect(preview.keyFingerprint).toBeNull();
    expect(preview.required.map((e) => e.id)).toEqual(["identity.federation"]);
    expect(preview.required[0]?.distributed).toBe(true);
    expect(preview.absent).toEqual(["enterprise.ca-administration", "not.in-this-catalog"]);
    expect(preview.optional.map((e) => e.id)).toContain("connectors.external");
    expect(preview.prohibited.map((e) => e.id)).toEqual(["telemetry.external"]);
    expect(preview.network).toEqual({
      externalServices: "allow",
      allowedServiceOrigins: ["https://id.example.test"],
    });
    expect(preview.provenance).toBe("invitation-unverified");
  });

  it("previews a signed envelope with an embedded key and shows the fingerprint to compare", async () => {
    const signer = await generatePolicySigningKey();
    const envelope = await signPolicyEnvelope(signer, {
      payload: FAMILY_POLICY,
      expires: "2027-01-01T00:00:00.000Z",
      allowedOrigins: ["https://vault.example.test"],
    });
    const preview = await previewJoinDocument(
      doc({ ...envelope, publicKey: signer.publicJwk }),
      FIXTURE_DISTRIBUTION,
      FIXTURE_CATALOG,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.signed).toBe(true);
    expect(preview.kid).toBe(signer.kid);
    expect(preview.keyFingerprint).toBe(keyFingerprint(signer.kid));
    expect(preview.kidMismatch).toBe(false);
    expect(preview.payloadDigest).toBe(envelope.payloadDigest);
    expect(preview.window).toEqual({ notBefore: null, expires: "2027-01-01T00:00:00.000Z" });
    expect(preview.allowedOrigins).toEqual(["https://vault.example.test"]);
    const other = await generatePolicySigningKey();
    const swapped = await previewJoinDocument(
      doc({ ...envelope, publicKey: other.publicJwk }),
      FIXTURE_DISTRIBUTION,
      FIXTURE_CATALOG,
    );
    expect(swapped.ok && swapped.kidMismatch).toBe(true);
  });

  it("TRUST-07: follows no URL, activates nothing, and names what it ignored", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const preview = await previewJoinDocument(
        doc({
          ...FAMILY_POLICY,
          policyUrl: "https://evil.example.test/policy.json",
          href: "https://evil.example.test/",
          activate: true,
        }),
        FIXTURE_DISTRIBUTION,
        FIXTURE_CATALOG,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(preview.ok && preview.ignoredMembers).toEqual(["activate", "href", "policyUrl"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses what it cannot bound", async () => {
    expect(await previewJoinDocument("nope", FIXTURE_DISTRIBUTION, FIXTURE_CATALOG)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(
      await previewJoinDocument(doc({ kind: "Other", instanceId: "x", revision: "1" }), FIXTURE_DISTRIBUTION, FIXTURE_CATALOG),
    ).toEqual({ ok: false, reason: "wrong-kind" });
    expect(
      await previewJoinDocument(doc({ kind: "InstanceCapabilityPolicy" }), FIXTURE_DISTRIBUTION, FIXTURE_CATALOG),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      await previewJoinDocument(
        doc({ ...FAMILY_POLICY, padding: "x".repeat(70_000) }),
        FIXTURE_DISTRIBUTION,
        FIXTURE_CATALOG,
      ),
    ).toEqual({ ok: false, reason: "too-large" });
    const flood = await previewJoinDocument(
      doc({
        ...FAMILY_POLICY,
        capabilities: {
          ...FAMILY_POLICY.capabilities,
          optional: Array.from({ length: 1000 }, (_, i) => `flood.id-${i}`),
        },
      }),
      FIXTURE_DISTRIBUTION,
      FIXTURE_CATALOG,
    );
    expect(flood.ok && flood.absent.length).toBe(256);
  });
});
