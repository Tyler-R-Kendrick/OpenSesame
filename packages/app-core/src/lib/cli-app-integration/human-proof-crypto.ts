/**
 * CLI humanProof wire format (`oschip2:`) — safe for Pages lazy leaves.
 */

export const CLI_APP_HUMAN_PROOF_PREFIX = "oschip2:";

export type CliAppHumanProofBinding = Readonly<{
  requestId: string;
  respondNonce: string;
  terminalSessionId: string;
  verb: string;
}>;

const PROOF_PIN_RE = /^oschip2:pin:([A-Za-z0-9_-]+)$/;
const PROOF_PASSKEY_RE = /^oschip2:passkey:(.+)$/;

export function isCliAppHumanProofValid(proof: string): boolean {
  const t = proof.trim();
  return PROOF_PIN_RE.test(t) || PROOF_PASSKEY_RE.test(t);
}

export function formatCliAppHumanProofPin(signatureB64: string): string {
  return `${CLI_APP_HUMAN_PROOF_PREFIX}pin:${signatureB64}`;
}

export function formatCliAppHumanProofPasskey(assertionJson: string): string {
  return `${CLI_APP_HUMAN_PROOF_PREFIX}passkey:${assertionJson}`;
}
