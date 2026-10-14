/**
 * P-256 signatures for CLI app-integration pairing and approvals (Rust parity).
 */

const enc = new TextEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export const PAIRING_CONFIRM_LABEL = "opensesame-cli-app-pairing-confirm.v1";
export const APPROVAL_CHALLENGE_LABEL = "opensesame-cli-app-approval.v1";

export async function approvalChallengeDigest(
  requestId: string,
  terminalSessionId: string,
  respondNonce: string,
  verb: string,
): Promise<Uint8Array> {
  const parts = [
    enc.encode(APPROVAL_CHALLENGE_LABEL),
    new Uint8Array([0]),
    enc.encode(requestId),
    new Uint8Array([0]),
    enc.encode(terminalSessionId),
    new Uint8Array([0]),
    enc.encode(respondNonce),
    new Uint8Array([0]),
    enc.encode(verb),
    new Uint8Array([0]),
  ];
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const msg = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    msg.set(part, off);
    off += part.byteLength;
  }
  return await sha256(msg);
}

export function pairingConfirmMessage(
  challenge: Uint8Array,
  code: string,
  origin: string,
): Uint8Array {
  const codeBytes = enc.encode(code);
  const originBytes = enc.encode(origin);
  const msg = new Uint8Array(
    enc.encode(PAIRING_CONFIRM_LABEL).byteLength +
      1 +
      challenge.byteLength +
      1 +
      codeBytes.byteLength +
      1 +
      originBytes.byteLength,
  );
  let off = 0;
  msg.set(enc.encode(PAIRING_CONFIRM_LABEL), off);
  off += enc.encode(PAIRING_CONFIRM_LABEL).byteLength;
  msg[off] = 0;
  off += 1;
  msg.set(challenge, off);
  off += challenge.byteLength;
  msg[off] = 0;
  off += 1;
  msg.set(codeBytes, off);
  off += codeBytes.byteLength;
  msg[off] = 0;
  off += 1;
  msg.set(originBytes, off);
  return msg;
}

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function exportSpkiB64(publicKey: CryptoKey): Promise<string> {
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  return b64urlEncode(spki);
}

export async function signP256Sha256B64(
  privateKey: CryptoKey,
  message: Uint8Array,
): Promise<string> {
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      message,
    ),
  );
  return b64urlEncode(sig);
}

/** CLI humanProof wire format (`oschip2:`) — loaded with device crypto only. */
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
