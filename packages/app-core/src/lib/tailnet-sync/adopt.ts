/**
 * Set up a new device from a tailnet drive (ADR 0140) — Enpass's "restore
 * from sync": write the drive's sealed body and portable header into this
 * device's personal tomb, then unlock it with the master password or a
 * synced passkey the way any vault opens.
 *
 * Nothing is decrypted here and nothing is overwritten: a device that already
 * holds a different vault in that tomb is refused, and one that already holds
 * this vault is left alone for the ordinary merge to bring up to date.
 */
import { isJsonObject, isString } from "@opensesame/os-domain";
import { writeLastVaultId } from "../last-vault.js";
import {
  BODY_PATH,
  HEADER_PATH,
  PERSONAL_TOMB,
  readPlaintextFile,
  readSealedFile,
  tombFileKey,
  vfsSeams,
  writePlaintextFile,
} from "../vfs.js";
import { type DriveTransport, defaultTransport } from "./engine.js";
import type { DrivePairing } from "./pairing.js";
import { type DriveSnapshot, adoptable, portableHeader } from "./snapshot.js";

export type AdoptResult = "adopted" | "already-here";

function storedCreatedAt(): string | null {
  const raw = readPlaintextFile(PERSONAL_TOMB, HEADER_PATH);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return isJsonObject(parsed) && isString(parsed.createdAt)
      ? parsed.createdAt
      : "";
  } catch {
    return "";
  }
}

export async function adoptSnapshot(
  snapshot: DriveSnapshot,
): Promise<AdoptResult> {
  if (snapshot.tomb !== PERSONAL_TOMB) {
    throw new Error("Only a personal vault can be set up from a drive.");
  }
  // Re-derived rather than trusted: a drive cannot add a PIN wrap or a hint.
  const header = portableHeader(snapshot.header, snapshot.rev);
  if (!adoptable(header)) {
    throw new Error(
      "That vault opens only with a PIN, which never leaves its device. Add a master password or passkey there first.",
    );
  }
  const existing = storedCreatedAt();
  if (existing === header.createdAt) return "already-here";
  if (existing !== null || readSealedFile(PERSONAL_TOMB, BODY_PATH)) {
    throw new Error(
      "This device already holds a different vault. Set it aside before syncing another one here.",
    );
  }
  // Body first, header second: a header is what makes a vault visible, so a
  // failure between the two leaves nothing that claims to be one.
  await vfsSeams.writeRaw(
    tombFileKey(PERSONAL_TOMB, BODY_PATH),
    JSON.stringify(snapshot.body),
  );
  await writePlaintextFile(PERSONAL_TOMB, HEADER_PATH, JSON.stringify(header));
  writeLastVaultId(PERSONAL_TOMB);
  return "adopted";
}

export async function adoptFromDrive(
  pairing: DrivePairing,
  transport: DriveTransport = defaultTransport,
): Promise<AdoptResult> {
  const remote = await transport.read(pairing);
  if (!remote.snapshot) {
    throw new Error(
      "The drive is empty. Sync from a device that holds the vault first.",
    );
  }
  return adoptSnapshot(remote.snapshot);
}
