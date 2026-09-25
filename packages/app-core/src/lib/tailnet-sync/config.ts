/**
 * Where this device keeps its drive pairing (ADR 0144): sealed in the vault's
 * own tomb, so the slot key is readable only while the vault is open, and
 * dropped with the tomb when the vault is destroyed.
 *
 * A pairing made before any vault is open — setting up a new device from the
 * drive — waits in memory until the adopted vault is unlocked, then is sealed
 * like any other. A reload before that forgets it, which costs a paste.
 */
import { isJsonObject, isString } from "@opensesame/os-domain";
import { VfsError, deleteFile, readFile, writeFile } from "../vfs.js";
import {
  type DrivePairing,
  formatPairingCode,
  parsePairingCode,
} from "./pairing.js";

export const DRIVE_CONFIG_PATH = "config/tailnet-drive";

let pending: { pairing: DrivePairing; tomb: string } | null = null;

/** Hold a pairing for the tomb it was adopted into, until that tomb opens. */
export function holdPendingPairing(pairing: DrivePairing, tomb: string): void {
  pending = { pairing, tomb };
}

/**
 * The pairing waiting for `tomb` to open, handed over once. A different vault
 * opening first — a project, say — neither takes it nor clears it.
 */
export function takePendingPairing(tomb: string): DrivePairing | null {
  if (pending?.tomb !== tomb) return null;
  const held = pending.pairing;
  pending = null;
  return held;
}

export async function readDriveConfig(
  tomb: string,
): Promise<DrivePairing | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(tomb, DRIVE_CONFIG_PATH);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!isJsonObject(parsed) || !isString(parsed.code)) return null;
    return parsePairingCode(parsed.code);
  } catch {
    return null;
  }
}

export async function writeDriveConfig(
  tomb: string,
  pairing: DrivePairing | null,
): Promise<void> {
  if (!pairing) {
    await deleteFile(tomb, DRIVE_CONFIG_PATH);
    return;
  }
  // Stored as the pairing code itself, so a stored value passes the same
  // checks a pasted one does every time it is read back.
  const text = JSON.stringify({ v: 1, code: formatPairingCode(pairing) });
  await writeFile(tomb, DRIVE_CONFIG_PATH, new TextEncoder().encode(text));
}
