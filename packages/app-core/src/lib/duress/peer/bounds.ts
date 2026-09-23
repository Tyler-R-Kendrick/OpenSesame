import { includesStringLiteral } from "../json-boundary.js";

/** Hard bounds for peer envelopes and pairing (INV-15, INV-26, INV-29). */
export const PEER_BOUNDS = {
  refMin: 1,
  refMax: 128,
  labelMax: 120,
  peersMax: 64,
  operationsMax: 16,
  nonceMin: 8,
  nonceMax: 64,
  payloadMaxBytes: 8_192,
  envelopeMaxBytes: 48_000,
  exportMaxChars: 1_800,
  qrMaxChars: 1_800,
  clockSkewMs: 5 * 60_000,
  maxTtlMs: 24 * 60 * 60_000,
  replayCacheMax: 4_096,
  httpBodyMaxBytes: 32_768,
} as const;

export const PEER_SIGN_ALGS = ["ECDSA-P256-SHA256"] as const;
export type PeerSignAlg = (typeof PEER_SIGN_ALGS)[number];

export const PEER_OPERATIONS = [
  "quarantine_device",
  "request_hold_ack",
  "deliver_alert_receipt",
  "peer_status",
  "pairing_rotate",
  "pairing_revoke",
] as const;
export type PeerOperation = (typeof PEER_OPERATIONS)[number];

export function isPeerOperation(value: string): value is PeerOperation {
  return includesStringLiteral(PEER_OPERATIONS, value);
}
