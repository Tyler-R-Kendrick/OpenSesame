import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  PEER_TRUST_ENVELOPE_KIND,
  PEER_TRUST_SIGNAL_KIND,
} from "./constants.js";
import type { SignedPeerTrustEnvelope } from "./envelope.js";
import type { PeerTrustSignal } from "./signaling.js";

const signedEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal(PEER_TRUST_ENVELOPE_KIND),
  spkiFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  enrollmentEpoch: z.number().int().min(1),
  spkiB64: z.string().min(1),
  signatureB64: z.string().min(1),
});

const DTLS = /^(?:absent|sha-256 [0-9a-f]{2}(?::[0-9a-f]{2}){31})$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const SPKI = /^[A-Za-z0-9+/]{80,200}={0,2}$/;
const SIG = /^[A-Za-z0-9+/]{40,200}={0,2}$/;

const peerTrustSignalSchema = z.object({
  kind: z.literal(PEER_TRUST_SIGNAL_KIND),
  envelope: signedEnvelopeSchema,
  ownerNonce: z.string().regex(NONCE),
  ownerDtls: z.string().regex(DTLS),
  introSignatureB64: z.string().regex(SIG),
});

const rememberedPeerSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  epoch: z.number().int().min(1),
});

const rememberedPeersSchema = z.object({
  id: z.literal("peers"),
  peers: z.array(rememberedPeerSchema).max(32),
});

const ownerCommitmentSchema = z.object({
  id: z.literal("commitment"),
  ownerKey: z.string().regex(/^[0-9a-f]{64}$/),
  ownerNonce: z.string().regex(NONCE),
  ownerDtls: z.string().regex(DTLS),
  ownerSpkiB64: z.string().regex(SPKI),
  enrollmentEpoch: z.number().int().min(1),
});

const persistedTrustSchema = z.object({
  id: z.literal("signed"),
  envelope: signedEnvelopeSchema,
  highWaterEpoch: z.number().int().min(0),
});

export function parseSignedPeerTrustEnvelope(
  value: BoundaryValue,
): SignedPeerTrustEnvelope | null {
  const parsed = signedEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parsePeerTrustSignal(
  value: BoundaryValue,
): PeerTrustSignal | null {
  const parsed = peerTrustSignalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parsePersistedTrustRow(
  value: BoundaryValue,
): z.infer<typeof persistedTrustSchema> | null {
  const parsed = persistedTrustSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseRememberedPeers(
  value: BoundaryValue,
): { fingerprint: string; epoch: number }[] {
  const parsed = rememberedPeersSchema.safeParse(value);
  return parsed.success ? parsed.data.peers : [];
}

export function parseOwnerCommitment(value: BoundaryValue): {
  ownerKey: string;
  ownerNonce: string;
  ownerDtls: string;
  ownerSpkiB64: string;
  enrollmentEpoch: number;
} | null {
  const parsed = ownerCommitmentSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    ownerKey: parsed.data.ownerKey,
    ownerNonce: parsed.data.ownerNonce,
    ownerDtls: parsed.data.ownerDtls,
    ownerSpkiB64: parsed.data.ownerSpkiB64,
    enrollmentEpoch: parsed.data.enrollmentEpoch,
  };
}

const arkRecordSchema = z.object({
  id: z.literal("signing"),
  publicSpkiB64: z.string().min(1),
});

export function parseArkRecord(
  value: BoundaryValue,
  privateKey: CryptoKey,
): { id: "signing"; privateKey: CryptoKey; publicSpkiB64: string } | null {
  const parsed = arkRecordSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    id: "signing",
    privateKey,
    publicSpkiB64: parsed.data.publicSpkiB64,
  };
}
