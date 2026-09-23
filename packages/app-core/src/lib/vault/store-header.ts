import { overlapCast } from "@opensesame/os-domain";
import { HEADER_PATH, listTombs, readPlaintextFile } from "../vfs.js";
import type { VaultHeader } from "./crypto.js";

/**
 * Whether any tomb on this device holds a sealed vault. The guest road
 * isolates itself whenever one does — a guest must never end up sealing the
 * tomb of a project that was created but not yet given its own key.
 */
export function deviceHoldsSealedVault(): boolean {
  return listTombs().some((tomb) => readTombHeader(tomb) !== null);
}

/**
 * Whether two headers carry an identical wrap record — the same password
 * wrap and derivation, the same PIN record, or the same passkey record. A
 * project forked "with this vault's key" starts with every record equal;
 * enrolling another method on one side leaves the shared ones intact, so
 * one identical record is enough to predict a shared key. It is a
 * prediction: opening the sealed body is the proof.
 */
export function sharesWrapRecord(a: VaultHeader, b: VaultHeader): boolean {
  const same = <T>(x: T, y: T) =>
    x !== undefined &&
    y !== undefined &&
    x !== null &&
    y !== null &&
    JSON.stringify(x) === JSON.stringify(y);
  if (same(a.wrap, b.wrap) && same(a.kdf, b.kdf)) return true;
  if (same(a.unlocks?.pin, b.unlocks?.pin)) return true;
  if (same(a.unlocks?.passkey, b.unlocks?.passkey)) return true;
  return false;
}

export function readTombHeader(tomb: string): VaultHeader | null {
  const raw = readPlaintextFile(tomb, HEADER_PATH);
  if (!raw) return null;
  try {
    return overlapCast(JSON.parse(raw));
  } catch {
    return null;
  }
}
