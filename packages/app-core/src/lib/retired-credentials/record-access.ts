/** Bounded retired credential storage and exact memory-hard matching. */
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core";
import { kvGet } from "../kv.js";
import { tombFileKey } from "../vfs.js";
import {
  type Records,
  type TrapRecord,
  parseRetiredCredentialRecords,
} from "./records.js";
export function key(tomb: string): string {
  return tombFileKey(tomb, "retired-credentials.v1");
}
export function read(tomb: string): Records {
  const raw = kvGet(key(tomb));
  if (!raw) return { v: 1, tomb, traps: [], events: [] };
  return parseRetiredCredentialRecords(raw, tomb);
}
/** Fixed bounded memory-hard KDF; exact bytes, no Unicode normalization. */
export async function verifier(
  password: string,
  salt: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(password);
  try {
    const { deriveRetiredVerifier } = await import("./argon-verifier.js");
    const derived = await deriveRetiredVerifier(bytes, b64ToBytes(salt));
    try {
      return bytesToB64(derived);
    } finally {
      derived.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}
export async function matches(
  password: string,
  traps: TrapRecord[],
): Promise<TrapRecord | null> {
  let found: TrapRecord | null = null;
  for (const t of traps)
    if ((await verifier(password, t.salt)) === t.verifier) {
      if (found) throw new Error("Ambiguous retired credential records.");
      found = t;
    }
  return found;
}
