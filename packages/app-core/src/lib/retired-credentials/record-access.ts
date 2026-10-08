/** Inactive bounded storage reader. A match establishes no owner authority. */
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core";
import { kvGet } from "../kv.js";
import { tombFileKey } from "../vfs.js";
import {
  deriveRetiredVerifier,
  passwordBytes,
  verifyRetiredPassword,
} from "./argon-verifier.js";
import {
  MAX_RETIRED_CREDENTIAL_TRAPS,
  type Records,
  type TrapRecord,
  parseRetiredCredentialRecords,
} from "./records.js";

export function key(tomb: string): string {
  if (!tomb.length || tomb.length > 256)
    throw new Error("Invalid retired credential context.");
  const bytes = passwordBytes(tomb);
  const valid = bytes.length <= 256;
  bytes.fill(0);
  if (!valid) throw new Error("Invalid retired credential context.");
  return tombFileKey(tomb, "retired-credentials.v1");
}
export function read(tomb: string): Records {
  const raw = kvGet(key(tomb));
  if (raw === null) return { v: 1, tomb, traps: [], events: [] };
  return parseRetiredCredentialRecords(raw, tomb);
}
function decode(value: string, length: 16 | 32): Uint8Array {
  if (value.length !== (length === 16 ? 24 : 44))
    throw new Error("Invalid retired credential records.");
  const bytes = b64ToBytes(value);
  if (bytes.length !== length || bytesToB64(bytes) !== value) {
    bytes.fill(0);
    throw new Error("Invalid retired credential records.");
  }
  return bytes;
}
/** Exact Unicode scalar sequence; no trimming or normalization. */
export async function verifier(
  password: string,
  salt: string,
): Promise<string> {
  const bytes = decode(salt, 16);
  try {
    return await deriveRetiredVerifier(password, bytes);
  } finally {
    bytes.fill(0);
  }
}
/** One fixed KDF/32-byte comparison per valid trap; no JS timing guarantee. */
export async function matches(
  password: string,
  traps: TrapRecord[],
): Promise<TrapRecord | null> {
  const probe = passwordBytes(password);
  probe.fill(0);
  if (!Array.isArray(traps) || traps.length > MAX_RETIRED_CREDENTIAL_TRAPS)
    throw new Error("Invalid retired credential records.");
  const decoded: {
    trap: TrapRecord;
    salt: Uint8Array;
    expected: Uint8Array;
  }[] = [];
  try {
    for (const trap of traps) {
      const salt = decode(trap.salt, 16);
      try {
        decoded.push({
          trap: { ...trap },
          salt,
          expected: decode(trap.verifier, 32),
        });
      } catch (error) {
        salt.fill(0);
        throw error;
      }
    }
    let found: TrapRecord | null = null;
    let count = 0;
    for (const entry of decoded) {
      if (await verifyRetiredPassword(password, entry.salt, entry.expected)) {
        found = entry.trap;
        count++;
      }
    }
    if (count > 1) throw new Error("Ambiguous retired credential records.");
    return found;
  } finally {
    for (const entry of decoded) {
      entry.salt.fill(0);
      entry.expected.fill(0);
    }
  }
}
