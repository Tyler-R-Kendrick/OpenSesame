/** Cooperative legacy-writer handoff. The durable marker is sealed in the
 * existing hash-named target database; no application names rest in its row. */
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { openOwnedDatabase } from "../ports.js";
import { atRestBinding, openAtRest, sealAtRest } from "./at-rest/cipher.js";
import { type AtRestKey, atRestReady } from "./at-rest/key.js";
import { edbDatabaseName, edbMasterKey } from "./encrypted-db/names.js";
import { storageWritesHalted } from "./storage-halt.js";

export type LegacyKind = "history-backups" | "password-history";
const STORE = "r";
const encoder = new TextEncoder();

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("Storage request failed"));
  });
}
function finished(tx: IDBTransaction): Promise<void> {
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("Storage transaction aborted"));
    tx.onerror = () =>
      reject(tx.error ?? new Error("Storage transaction failed"));
  });
  // A request failure can reach the caller before completion rejects.
  // Observe both; callers still await the original rejecting promise.
  void completion.catch(() => {});
  return completion;
}

function markerBinding(name: string, slot: string): Uint8Array {
  return atRestBinding(`legacy-transfer.v1.${name}`, slot);
}
async function context(kind: LegacyKind) {
  if (storageWritesHalted()) throw new Error("Storage writes halted");
  const atRest = await atRestReady();
  if (!atRest.durable) throw new Error("Durable device key unavailable");
  const master = edbMasterKey(atRest.key);
  try {
    const name = edbDatabaseName(master, kind);
    const slot = bytesToHex(
      hmac(sha256, master, encoder.encode(`legacy-transfer.v1.${kind}`)),
    );
    return { atRest, name, slot };
  } finally {
    master.fill(0);
  }
}

function openMarker(
  name: string,
  create: boolean,
): Promise<IDBDatabase | undefined> {
  if (storageWritesHalted())
    return Promise.reject(new Error("Storage writes halted"));
  return new Promise((resolve, reject) => {
    const req = openOwnedDatabase(name, 1);
    let missing = false;
    let active = true;
    req.onupgradeneeded = () => {
      if (!active || !create) {
        missing = true;
        req.transaction?.abort();
        return;
      }
      const store = req.result.createObjectStore(STORE);
      store.createIndex("x", "x", { multiEntry: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      if (!active) db.close();
      else resolve(db);
    };
    req.onerror = () =>
      missing
        ? resolve(undefined)
        : reject(req.error ?? new Error("Marker unavailable"));
    req.onblocked = () => {
      active = false;
      reject(new Error("Marker blocked"));
    };
  });
}

function tokenOf(
  row: BoundaryValue | undefined,
  atRest: AtRestKey,
  name: string,
  slot: string,
): string | undefined {
  if (row === undefined || row === null) return undefined;
  if (!isJsonObject(row) || !isString(row.c))
    throw new Error("Invalid handoff marker");
  const text = openAtRest(atRest.key, markerBinding(name, slot), row.c);
  if (text === null) throw new Error("Handoff marker does not open");
  const value: BoundaryValue = JSON.parse(text);
  if (!isJsonObject(value) || !isString(value.token) || !value.token)
    throw new Error("Invalid handoff marker");
  return value.token;
}

export class LegacyTransferDeniedError extends Error {
  constructor() {
    super("Legacy storage transferred or unavailable; reload this device");
    this.name = "LegacyTransferDeniedError";
  }
}

/** Missing marker permits legacy routing; errors never count as absence. */
export async function assertLegacyWritable(kind: LegacyKind): Promise<void> {
  try {
    await checkLegacyWritable(kind);
  } catch {
    throw new LegacyTransferDeniedError();
  }
}

async function checkLegacyWritable(kind: LegacyKind): Promise<void> {
  const { atRest, name, slot } = await context(kind);
  const db = await openMarker(name, false);
  if (!db) return;
  try {
    const row: BoundaryValue = await request(
      db.transaction(STORE, "readonly").objectStore(STORE).get(slot),
    );
    if (tokenOf(row, atRest, name, slot) !== undefined)
      throw new Error("Legacy storage transferred; reload this device");
  } finally {
    db.close();
  }
}

export type TransferClaim = Readonly<{
  release: () => Promise<void>;
  assertOwned: () => Promise<void>;
  guardWrite: (store: IDBObjectStore) => Promise<void>;
}>;
/** Atomically claim the marker. A concurrent/finished transfer refuses. */
export async function claimLegacyTransfer(
  kind: LegacyKind,
  restart = false,
): Promise<TransferClaim> {
  const { atRest, name, slot } = await context(kind);
  const db = await openMarker(name, true);
  if (!db) throw new Error("Handoff marker unavailable");
  const token = crypto.randomUUID();
  try {
    const tx = db.transaction(STORE, "readwrite");
    const done = finished(tx);
    const rows = tx.objectStore(STORE);
    const row: BoundaryValue = await request(rows.get(slot));
    if (tokenOf(row, atRest, name, slot) !== undefined && !restart) {
      await done;
      throw new Error("Legacy transfer already claimed");
    }
    await request(
      rows.put(
        {
          c: sealAtRest(
            atRest.key,
            markerBinding(name, slot),
            JSON.stringify({ token }),
          ),
          x: [],
        },
        slot,
      ),
    );
    await done;
  } finally {
    db.close();
  }
  return {
    guardWrite: async (store) => {
      if (storageWritesHalted()) throw new Error("Storage writes halted");
      const row: BoundaryValue = await request(store.get(slot));
      if (tokenOf(row, atRest, name, slot) !== token)
        throw new Error("Legacy transfer ownership changed");
    },
    assertOwned: async () => {
      if (storageWritesHalted()) throw new Error("Storage writes halted");
      const opened = await openMarker(name, false);
      if (!opened) throw new Error("Handoff marker missing");
      try {
        const row: BoundaryValue = await request(
          opened.transaction(STORE, "readonly").objectStore(STORE).get(slot),
        );
        if (tokenOf(row, atRest, name, slot) !== token)
          throw new Error("Legacy transfer ownership changed");
      } finally {
        opened.close();
      }
    },
    release: async () => {
      // Terminal reset owns deletion; teardown must not reopen halted storage.
      if (storageWritesHalted()) return;
      const opened = await openMarker(name, false);
      if (!opened) return;
      try {
        const tx = opened.transaction(STORE, "readwrite");
        const done = finished(tx);
        const rows = tx.objectStore(STORE);
        const row: BoundaryValue = await request(rows.get(slot));
        if (tokenOf(row, atRest, name, slot) === token)
          await request(rows.delete(slot));
        await done;
      } finally {
        opened.close();
      }
    },
  };
}

/** Bounded open: a cancelled request may later settle, but can only close
 * its handle or abort creation, never start a delayed transfer. */
export function openLegacySource(
  name: string,
): Promise<IDBDatabase | undefined> {
  if (storageWritesHalted())
    return Promise.reject(new Error("Storage writes halted"));
  return new Promise((resolve, reject) => {
    const req = openOwnedDatabase(name);
    let missing = false;
    let active = true;
    const timer = setTimeout(() => {
      active = false;
      reject(new Error("Legacy source open timed out"));
    }, 5000);
    req.onupgradeneeded = () => {
      missing = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      db.onversionchange = () => db.close();
      if (!active) db.close();
      else {
        active = false;
        resolve(db);
      }
    };
    req.onerror = () => {
      clearTimeout(timer);
      if (!active) return;
      active = false;
      if (missing) resolve(undefined);
      else reject(req.error ?? new Error("Legacy source unavailable"));
    };
  });
}

/** Current cooperative opens drain on versionchange. Blocked upgrades abort
 * if they later become runnable, so returning cannot schedule a late fence. */
export async function fenceLegacyDatabase(
  name: string,
): Promise<IDBDatabase | undefined> {
  const current = await openLegacySource(name);
  if (!current) return undefined;
  const version = current.version;
  current.close();
  return new Promise((resolve, reject) => {
    const req = openOwnedDatabase(name, version + 1);
    let active = true;
    const timer = setTimeout(() => {
      active = false;
      reject(new Error("Legacy fence timed out"));
    }, 5000);
    req.onupgradeneeded = () => {
      if (!active || storageWritesHalted()) req.transaction?.abort();
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      if (!active) req.result.close();
      else {
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      }
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(req.error ?? new Error("Legacy fence failed"));
    };
    req.onblocked = () => {
      active = false;
      clearTimeout(timer);
      reject(new Error("Legacy peer still holds storage"));
    };
  });
}
