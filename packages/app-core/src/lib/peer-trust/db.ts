/**
 * One opener for the peer-trust database (version 1). Ark, enrollment, and
 * remembered peers share it so the PWA does not ship three copies.
 */
import { openOwnedDatabase } from "../../ports.js";
import { PEER_TRUST_DATABASE } from "../storage-ownership.js";

const DB_VERSION = 1;

export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
  });
}

export function openPeerTrustDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = openOwnedDatabase(PEER_TRUST_DATABASE, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("trust")) {
        db.createObjectStore("trust", { keyPath: "id" });
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
