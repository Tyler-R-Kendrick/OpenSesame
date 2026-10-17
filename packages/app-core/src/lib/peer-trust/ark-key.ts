/**
 * PWA application root key (ARK): non-extractable P-256 signing key in IndexedDB.
 * Peering trust anchors here — never a host, daemon, or CLI helper.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { openPeerTrustDb as openDb, idbRequest as request } from "./db.js";
import { exportSpkiB64, fingerprintOfSpki } from "./fingerprint.js";
import { parseArkRecord } from "./parse.js";

const STORE = "ark";
const RECORD = "signing";

type ArkRecord = Readonly<{
  id: typeof RECORD;
  privateKey: CryptoKey;
  publicSpkiB64: string;
}>;

export type PeerArkSigningKey = Readonly<{
  privateKey: CryptoKey;
  publicSpkiB64: string;
  spkiFingerprint: string;
}>;

async function readArk(db: IDBDatabase): Promise<ArkRecord | null> {
  const found: BoundaryValue = await request(
    db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD),
  );
  if (!(found instanceof Object) || !("privateKey" in found)) return null;
  const { privateKey } = found;
  if (!(privateKey instanceof CryptoKey)) return null;
  return parseArkRecord(found, privateKey);
}

async function mintNonExtractableSigningKeyFromPair(
  pair: CryptoKeyPair,
): Promise<CryptoKey> {
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256") {
    throw new Error("unexpected P-256 key material");
  }
  const x = privateJwk.x;
  const y = privateJwk.y;
  const d = privateJwk.d;
  if (x === undefined || y === undefined || d === undefined) {
    throw new Error("unexpected P-256 key material");
  }
  return await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x,
      y,
      d,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function writeArk(db: IDBDatabase, record: ArkRecord): Promise<void> {
  await request(
    db.transaction(STORE, "readwrite").objectStore(STORE).put(record),
  );
}

/** Load or create the device's peer-trust ARK while the vault session allows storage. */
export async function ensurePeerArkSigningKey(): Promise<PeerArkSigningKey | null> {
  const db = await openDb();
  try {
    const existing = await readArk(db);
    if (existing) {
      const der = Uint8Array.from(atob(existing.publicSpkiB64), (c) =>
        c.charCodeAt(0),
      );
      return {
        privateKey: existing.privateKey,
        publicSpkiB64: existing.publicSpkiB64,
        spkiFingerprint: await fingerprintOfSpki(der),
      };
    }
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const privateKey = await mintNonExtractableSigningKeyFromPair(pair);
    const publicSpkiB64 = await exportSpkiB64(pair.publicKey);
    const der = Uint8Array.from(atob(publicSpkiB64), (c) => c.charCodeAt(0));
    await writeArk(db, { id: RECORD, privateKey, publicSpkiB64 });
    return {
      privateKey,
      publicSpkiB64,
      spkiFingerprint: await fingerprintOfSpki(der),
    };
  } finally {
    db.close();
  }
}
