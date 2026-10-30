/**
 * Approval challenge digests and pairing-confirm messages (Rust parity).
 */

const enc = new TextEncoder();

export const PAIRING_CONFIRM_LABEL = "opensesame-cli-app-pairing-confirm.v1";
export const APPROVAL_CHALLENGE_LABEL = "opensesame-cli-app-approval.v1";
export const APPROVAL_CHALLENGE_V3_LABEL = "opensesame-cli-app-approval.v3";

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(data)),
  );
}

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

export async function approvalChallengeDigestV3(input: {
  daemonIntegrationId: string;
  requestId: string;
  terminalSessionId: string;
  respondNonce: string;
  verb: string;
  argvHash: string;
  peerPid: number;
  peerStartTime: number;
}): Promise<Uint8Array> {
  const parts: Uint8Array[] = [
    enc.encode(APPROVAL_CHALLENGE_V3_LABEL),
    new Uint8Array([0]),
  ];
  for (const segment of [
    input.daemonIntegrationId,
    input.requestId,
    input.terminalSessionId,
    input.respondNonce,
    input.verb,
    input.argvHash,
    String(input.peerPid),
    String(input.peerStartTime),
  ]) {
    parts.push(enc.encode(segment), new Uint8Array([0]));
  }
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
  const labelBytes = enc.encode(PAIRING_CONFIRM_LABEL);
  const codeBytes = enc.encode(code);
  const originBytes = enc.encode(origin);
  const msg = new Uint8Array(
    labelBytes.byteLength +
      1 +
      challenge.byteLength +
      1 +
      codeBytes.byteLength +
      1 +
      originBytes.byteLength,
  );
  let off = 0;
  msg.set(labelBytes, off);
  off += labelBytes.byteLength;
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
