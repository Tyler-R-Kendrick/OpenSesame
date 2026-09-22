/**
 * Where a policy came from, said plainly (S03).
 *
 * Provenance is shown to people and never inferred from content. A
 * same-origin deployment document is trusted exactly as far as the
 * deployment that serves the app is — and the copy says so instead of
 * calling it "verified". A signed import is a verification claim against a
 * key the device already trusts. An invitation is unverified until the
 * person compares the key fingerprint out of band.
 */
import type { PolicyProvenance } from "@opensesame/capability-composition";

export type PolicySource = Readonly<
  | { kind: "none" }
  | { kind: "runtime-config" }
  | { kind: "signed-import"; verified: boolean }
  | { kind: "invitation"; fingerprintConfirmed: boolean; verified: boolean }
>;

export function classifyPolicySource(source: PolicySource): PolicyProvenance {
  switch (source.kind) {
    case "none":
      return "personal-local";
    case "runtime-config":
      return "same-origin-deployment";
    case "signed-import":
      return source.verified ? "signed-import" : "invitation-unverified";
    case "invitation":
      return source.verified && source.fingerprintConfirmed
        ? "signed-import"
        : "invitation-unverified";
  }
}

export type ProvenanceTrust = "local" | "deployment" | "verified" | "unverified";

export type ProvenanceCopy = Readonly<{
  /** Short noun for a row or a badge. */
  label: string;
  /** One honest sentence a reviewer reads before accepting. */
  claim: string;
  trust: ProvenanceTrust;
}>;

const COPY: Readonly<Record<PolicyProvenance, ProvenanceCopy>> = Object.freeze({
  "personal-local": {
    label: "This device",
    claim: "Written on this device. No operator is involved.",
    trust: "local",
  },
  "same-origin-deployment": {
    label: "This deployment",
    claim:
      "Delivered with the app by the origin that serves it. Trusted as far as that deployment is, no further.",
    trust: "deployment",
  },
  "signed-import": {
    label: "Signed policy",
    claim: "Signature verified against a key this device already trusts.",
    trust: "verified",
  },
  "invitation-unverified": {
    label: "Invitation",
    claim:
      "Not verified. Compare the key fingerprint with the person who sent it before accepting.",
    trust: "unverified",
  },
});

export function provenanceCopy(provenance: PolicyProvenance): ProvenanceCopy {
  return COPY[provenance];
}

/** Only a verified or deployment-delivered policy may become the ceiling. */
export function provenanceMayGovern(provenance: PolicyProvenance): boolean {
  return provenance !== "invitation-unverified";
}
