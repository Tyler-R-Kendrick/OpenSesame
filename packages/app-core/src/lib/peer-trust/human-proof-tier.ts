/**
 * Software / virtual passkeys may authorize low-risk peer verbs only (D7-2 §6).
 * High-risk peer operations require a hardware-backed passkey proof kind.
 */

const CLI_HIGH_RISK_VERBS = new Set(["run", "env-resolve", "pass-reveal"]);

const PEER_HIGH_RISK_VERBS = new Set([
  "peer-reveal",
  "peer-write",
  "live-device-grant",
]);

export function verbRequiresHardwarePasskey(verb: string): boolean {
  return CLI_HIGH_RISK_VERBS.has(verb) || PEER_HIGH_RISK_VERBS.has(verb);
}

export function softwarePasskeyAllowedForVerb(verb: string): boolean {
  return !verbRequiresHardwarePasskey(verb);
}

export function humanProofKindAllowsVerb(
  proofKind: "passkey" | "software-passkey" | "pin",
  verb: string,
): boolean {
  if (proofKind === "software-passkey") {
    return softwarePasskeyAllowedForVerb(verb);
  }
  return proofKind === "passkey" || proofKind === "pin";
}
