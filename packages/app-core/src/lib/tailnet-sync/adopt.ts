/**
 * Set up a vault on this device from a tailnet drive (ADR 0144) — Enpass's
 * "restore from sync": write the drive's sealed body and portable header into
 * the tomb it was sealed in, then unlock it with the master password or a
 * synced passkey the way any vault opens. That is the personal tomb, or a
 * project's (`prj_<uuid>`), which lands beside whatever vaults this device
 * already holds and is listed with them.
 *
 * Nothing is decrypted here and nothing is overwritten: a device that already
 * holds a different vault in that tomb is refused, and one that already holds
 * this vault is left alone for the ordinary merge to bring up to date.
 */
import { isJsonObject, isString } from "@opensesame/os-domain";
import { kvHydrate } from "../kv.js";
import { writeLastVaultId } from "../last-vault.js";
import { tombStorageKeys } from "../vault/tomb-migration.js";
import {
  BODY_PATH,
  HEADER_PATH,
  PERSONAL_TOMB,
  readPlaintextFile,
  readSealedFile,
  registerTomb,
  tombFileKey,
  vfsSeams,
  writePlaintextFile,
} from "../vfs.js";
import { type DriveSnapshot, adoptable, portableHeader } from "./snapshot.js";

export type AdoptResult = "adopted" | "already-here";

/** A project vault's tomb, as `projects.ts` names one. */
const PROJECT_TOMB =
  /^prj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isProjectTomb(tomb: string): boolean {
  return PROJECT_TOMB.test(tomb);
}

function storedCreatedAt(tomb: string): string | null {
  const raw = readPlaintextFile(tomb, HEADER_PATH);
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
  const { tomb } = snapshot;
  if (tomb !== PERSONAL_TOMB && !isProjectTomb(tomb)) {
    throw new Error("The drive holds a vault this device cannot set up.");
  }
  // Re-derived rather than trusted: a drive cannot add a PIN wrap or a hint.
  const header = portableHeader(snapshot.header, snapshot.rev);
  if (!adoptable(header)) {
    throw new Error(
      "That vault opens only with a PIN, which never leaves its device. Add a master password or passkey there first.",
    );
  }
  // What is on disk, not only what this tab has read: a project's tomb may
  // never have been opened here.
  await kvHydrate(tombStorageKeys(tomb));
  const existing = storedCreatedAt(tomb);
  if (existing === header.createdAt) return "already-here";
  if (existing !== null || readSealedFile(tomb, BODY_PATH)) {
    throw new Error(
      "This device already holds a different vault. Set it aside before syncing another one here.",
    );
  }
  // Registered first, so a set-up cut short is a tomb the device lists and
  // can remove; then body, then header: a header is what makes a vault
  // visible, so a failure between the two leaves nothing that claims to be one.
  if (tomb !== PERSONAL_TOMB) await registerTomb(tomb);
  await vfsSeams.writeRaw(
    tombFileKey(tomb, BODY_PATH),
    JSON.stringify(snapshot.body),
  );
  await writePlaintextFile(tomb, HEADER_PATH, JSON.stringify(header));
  if (tomb === PERSONAL_TOMB) writeLastVaultId(PERSONAL_TOMB);
  return "adopted";
}
