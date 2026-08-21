import type {
  AssuranceLevel,
  AssuranceRequirement,
  AssuranceVector,
  IdentityEvidence,
  TrustSession,
} from "@opensesame/os-domain";
const proofing = [
  "none",
  "self_attested",
  "verified_account",
  "remote_unattended",
  "remote_attended",
  "in_person",
  "enterprise_asserted",
] as const;
const device = ["none", "software", "hardware"] as const;
const protection = [
  "unknown",
  "software_exportable",
  "software_non_exportable",
  "tee_backed",
  "strongbox_backed",
  "external_hardware",
] as const;
const rank = <T>(values: readonly T[], value: T | undefined) =>
  value === undefined ? -1 : values.indexOf(value);
export interface AssuranceDecision {
  allowed: boolean;
  satisfied: string[];
  missing: string[];
  evidence: string[];
  reasonCodes: string[];
  legacyProjection: AssuranceLevel;
}
export function evaluateAssurance(input: {
  evidence: IdentityEvidence[];
  authentication?: AssuranceVector["authentication"];
  trustSession?: TrustSession;
  requirement: AssuranceRequirement;
  now: Date;
}): AssuranceDecision {
  const r = input.requirement;
  const selected = input.evidence.filter(
    (e) =>
      e.state === "active" &&
      (!e.expiresAt || e.expiresAt > input.now) &&
      (!r.acceptableIssuers || r.acceptableIssuers.includes(e.issuer)) &&
      e.assurance.subjectKind === r.subjectKind &&
      (!r.maximumEvidenceAgeSeconds ||
        input.now.getTime() - e.verifiedAt.getTime() <=
          r.maximumEvidenceAgeSeconds * 1000),
  );
  const auth =
    input.authentication ?? input.trustSession?.assurance.authentication;
  const vector = selected[0]?.assurance;
  const missing: string[] = [];
  const satisfied: string[] = [];
  if (!vector) missing.push("identity_evidence");
  else satisfied.push("identity_evidence");
  if (
    r.minimumIdentityProofing?.length &&
    (!vector?.identityProofing ||
      !r.minimumIdentityProofing.some(
        (x) => rank(proofing, vector.identityProofing) >= rank(proofing, x),
      ))
  )
    missing.push("identity_proofing");
  else if (r.minimumIdentityProofing?.length)
    satisfied.push("identity_proofing");
  if (r.requireUserVerification && (!auth || auth.userVerification === "none"))
    missing.push("user_verification");
  else if (r.requireUserVerification) satisfied.push("user_verification");
  if (r.requirePhishingResistance && auth?.phishingResistant !== true)
    missing.push("phishing_resistance");
  else if (r.requirePhishingResistance) satisfied.push("phishing_resistance");
  if (r.requireVerifierNameBinding && auth?.verifierNameBound !== true)
    missing.push("verifier_name_binding");
  else if (r.requireVerifierNameBinding)
    satisfied.push("verifier_name_binding");
  if (
    r.minimumDeviceBinding?.length &&
    (!auth ||
      !r.minimumDeviceBinding.some(
        (x) => rank(device, auth.deviceBinding) >= rank(device, x),
      ))
  )
    missing.push("device_binding");
  else if (r.minimumDeviceBinding?.length) satisfied.push("device_binding");
  if (
    r.minimumKeyProtection?.length &&
    (!auth ||
      !r.minimumKeyProtection.some(
        (x) => rank(protection, auth.keyProtection) >= rank(protection, x),
      ))
  )
    missing.push("key_protection");
  else if (r.minimumKeyProtection?.length) satisfied.push("key_protection");
  if (
    r.acceptableAcrValues?.length &&
    (!auth?.acr || !r.acceptableAcrValues.includes(auth.acr))
  )
    missing.push("acr");
  else if (r.acceptableAcrValues?.length) satisfied.push("acr");
  if (
    r.maximumAuthenticationAgeSeconds !== undefined &&
    (!auth?.authenticatedAt ||
      input.now.getTime() - auth.authenticatedAt.getTime() >
        r.maximumAuthenticationAgeSeconds * 1000)
  )
    missing.push("authentication_freshness");
  else if (r.maximumAuthenticationAgeSeconds !== undefined)
    satisfied.push("authentication_freshness");
  const allowed = missing.length === 0;
  return {
    allowed,
    satisfied,
    missing,
    evidence: selected.map((e) => e.id),
    reasonCodes: allowed
      ? ["assurance_satisfied"]
      : ["insufficient_user_authentication", ...missing],
    legacyProjection: projectLegacy(vector, auth),
  };
}
export function projectLegacy(
  vector?: AssuranceVector,
  auth?: AssuranceVector["authentication"],
): AssuranceLevel {
  if (!vector) return "provisional";
  if (vector.subjectKind === "workload") return "workload_attested";
  if (vector.identityProofing === "enterprise_asserted")
    return "enterprise_managed";
  if (auth?.phishingResistant) return "phishing_resistant";
  if (auth?.factorCount === 2) return "mfa";
  if (
    vector.identityProofing === "verified_account" ||
    vector.identityProofing === "remote_attended" ||
    vector.identityProofing === "in_person"
  )
    return "verified";
  return "self_asserted";
}
