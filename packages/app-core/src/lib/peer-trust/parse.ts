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

const peerTrustSignalSchema = z.object({
  kind: z.literal(PEER_TRUST_SIGNAL_KIND),
  sas: z.string().min(1),
  envelope: signedEnvelopeSchema,
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
