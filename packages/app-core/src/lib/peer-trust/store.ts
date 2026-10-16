/**
 * Authenticated peer trust store held in the PWA (versioned ARK-signed epoch).
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { openOwnedDatabase } from "../../ports.js";
import { PEER_TRUST_DATABASE } from "../storage-ownership.js";
import { ensurePeerArkSigningKey } from "./ark-key.js";
import {
  type SignedPeerTrustEnvelope,
  recordFromEnvelope,
  signPeerTrustEnvelope,
  verifyPeerTrustEnvelope,
} from "./envelope.js";
import { fingerprintOfSpkiB64 } from "./fingerprint.js";
import { parsePersistedTrustRow } from "./parse.js";
import {
  type PeerTrustRecord,
  nextEnrollmentEpoch,
  parsePeerTrustRecord,
} from "./record.js";
import { sasFromFingerprint } from "./sas.js";

const DB_VERSION = 1;
const STORE = "trust";
const RECORD = "signed";

type PersistedTrust = Readonly<{
  id: typeof RECORD;
  envelope: SignedPeerTrustEnvelope;
  highWaterEpoch: number;
}>;

export type PeerTrustLoadResult =
  | {
      ok: true;
      record: PeerTrustRecord;
      sas: string;
      envelope: SignedPeerTrustEnvelope;
    }
  | {
      ok: false;
      reason: "missing" | "tampered" | "downgrade" | "ark-unavailable";
    };

export type PeerTrustCommitResult =
  | {
      ok: true;
      record: PeerTrustRecord;
      sas: string;
      envelope: SignedPeerTrustEnvelope;
    }
  | {
      ok: false;
      reason: "ark-unavailable" | "fingerprint-mismatch" | "epoch-regression";
    };

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = openOwnedDatabase(PEER_TRUST_DATABASE, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("ark")) {
        db.createObjectStore("ark", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

async function readPersisted(db: IDBDatabase): Promise<PersistedTrust | null> {
  const found: BoundaryValue = await request(
    db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD),
  );
  const parsed = parsePersistedTrustRow(found);
  return parsed ?? null;
}

async function writePersisted(
  db: IDBDatabase,
  row: PersistedTrust,
): Promise<void> {
  await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(row));
}

/** Load the signed trust record; refuses tampering and epoch rollback. */
export async function loadPeerTrustStore(): Promise<PeerTrustLoadResult> {
  const ark = await ensurePeerArkSigningKey();
  if (!ark) return { ok: false, reason: "ark-unavailable" };
  const db = await openDb();
  try {
    const persisted = await readPersisted(db);
    if (!persisted) return { ok: false, reason: "missing" };
    const valid = await verifyPeerTrustEnvelope(persisted.envelope);
    if (!valid) return { ok: false, reason: "tampered" };
    if (persisted.envelope.enrollmentEpoch < persisted.highWaterEpoch) {
      return { ok: false, reason: "downgrade" };
    }
    const fingerprint = await fingerprintOfSpkiB64(persisted.envelope.spkiB64);
    if (fingerprint !== persisted.envelope.spkiFingerprint) {
      return { ok: false, reason: "tampered" };
    }
    const record = recordFromEnvelope(persisted.envelope);
    if (!record) return { ok: false, reason: "tampered" };
    const parsed = parsePeerTrustRecord(record);
    if (parsed === "invalid") return { ok: false, reason: "tampered" };
    const sas = sasFromFingerprint(parsed.spkiFingerprint);
    if (!sas) return { ok: false, reason: "tampered" };
    return {
      ok: true,
      record: parsed,
      sas,
      envelope: persisted.envelope,
    };
  } finally {
    db.close();
  }
}

/** Commit the current ARK as enrolled trust (first enroll or rotation). */
export async function commitPeerTrustEnrollment(
  _rememberedFingerprint: string | undefined,
): Promise<PeerTrustCommitResult> {
  const ark = await ensurePeerArkSigningKey();
  if (!ark) return { ok: false, reason: "ark-unavailable" };
  const db = await openDb();
  try {
    const persisted = await readPersisted(db);
    const currentRecord =
      persisted && (await verifyPeerTrustEnvelope(persisted.envelope))
        ? recordFromEnvelope(persisted.envelope)
        : null;
    const epoch = nextEnrollmentEpoch(currentRecord);
    if (
      persisted &&
      epoch <= persisted.highWaterEpoch &&
      currentRecord?.spkiFingerprint === ark.spkiFingerprint
    ) {
      return { ok: false, reason: "epoch-regression" };
    }
    const record = parsePeerTrustRecord({
      spkiFingerprint: ark.spkiFingerprint,
      enrollmentEpoch: epoch,
    });
    if (record === "invalid") {
      return { ok: false, reason: "fingerprint-mismatch" };
    }
    const envelope = await signPeerTrustEnvelope(
      ark.privateKey,
      record,
      ark.publicSpkiB64,
    );
    const highWaterEpoch = Math.max(epoch, persisted?.highWaterEpoch ?? 0);
    await writePersisted(db, {
      id: RECORD,
      envelope,
      highWaterEpoch,
    });
    const sas = sasFromFingerprint(record.spkiFingerprint);
    if (!sas) return { ok: false, reason: "fingerprint-mismatch" };
    return { ok: true, record, sas, envelope };
  } finally {
    db.close();
  }
}
