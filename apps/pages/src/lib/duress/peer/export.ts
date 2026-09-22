/**
 * Bounded encrypted peer export/import + small QR (PEER-D).
 * Uses @opensesame/qr for SVG encoding; refuses oversized payloads.
 */

import { encodeQrSize, encodeQrSvg } from "@opensesame/qr";
import {
  type JsonObject,
  isJsonObject,
  overlapCast,
} from "../json-boundary.js";
import type { PeerPairing } from "./pairing.js";

type ExportedPeerPairingWire = Readonly<{
  peerRef: string;
  origin: string;
  recipientPrincipalRef: string;
  recipientPublicKeyJwk: JsonWebKey;
  generation: number;
  delegations: PeerPairing["delegations"];
}>;

const MAX_EXPORT_CHARS = 1800; // keep QR scannable / bounded

export type PeerExportBlob = Readonly<{
  schemaVersion: 1;
  kind: "duress_peer_pairing";
  ciphertextB64: string;
  issuedAt: string;
  expiresAt: string;
}>;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function exportPeerPairing(
  pairing: PeerPairing,
  wrapKey: CryptoKey,
  ttlMs: number,
  now = Date.now(),
): Promise<PeerExportBlob> {
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      peerRef: pairing.peerRef,
      origin: pairing.origin,
      recipientPrincipalRef: pairing.recipientPrincipalRef,
      recipientPublicKeyJwk: pairing.recipientPublicKeyJwk,
      generation: pairing.generation,
      delegations: pairing.delegations,
    }),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, plaintext),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  const blob: PeerExportBlob = {
    schemaVersion: 1,
    kind: "duress_peer_pairing",
    ciphertextB64: b64(packed),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  const serialized = JSON.stringify(blob);
  if (serialized.length > MAX_EXPORT_CHARS) {
    throw new Error("unsupported_factor: export too large for QR");
  }
  return blob;
}

export async function importPeerPairing(
  blob: PeerExportBlob,
  wrapKey: CryptoKey,
  now = Date.now(),
): Promise<Omit<PeerPairing, "consentedAt" | "revokedAt">> {
  if (blob.schemaVersion !== 1 || blob.kind !== "duress_peer_pairing") {
    throw new Error("unsupported_profile_version");
  }
  if (Date.parse(blob.expiresAt) < now) throw new Error("stale_session");
  const packed = fromB64(blob.ciphertextB64);
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const plain = new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, wrapKey, ct),
  );
  const wire = JSON.parse(plain);
  if (!isJsonObject(wire)) throw new Error("unsupported_factor");
  const parsed = overlapCast<JsonObject, ExportedPeerPairingWire>(wire);
  return {
    peerRef: parsed.peerRef,
    origin: parsed.origin,
    recipientPrincipalRef: parsed.recipientPrincipalRef,
    recipientPublicKeyJwk: parsed.recipientPublicKeyJwk,
    generation: parsed.generation,
    delegations: parsed.delegations,
  };
}

export function peerExportToQrSvg(blob: PeerExportBlob): string {
  const payload = JSON.stringify(blob);
  if (payload.length > MAX_EXPORT_CHARS) {
    throw new Error("unsupported_factor: export too large for QR");
  }
  // Touch size API to validate encode path
  if (encodeQrSize(payload) < 1)
    throw new Error("unsupported_factor: qr encode");
  return encodeQrSvg(payload);
}
