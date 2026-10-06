/** Construct an encrypted backup from persisted owner vault files. */
import { overlapCast } from "@opensesame/os-domain";
import type { SealedBlob, VaultHeader } from "@opensesame/vault-core";
import {
  buildOfflineBackup,
  serializeOfflineBackup,
} from "./vault/offline-backup.js";
import { GUEST_TOMB, vaultStore } from "./vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  readPlaintextFile,
  readSealedFile,
} from "./vfs.js";

export function sealedEnvelopeJson(): string {
  const { status, tomb } = vaultStore.getSnapshot();
  if (tomb === GUEST_TOMB) {
    throw new Error("Guest vaults cannot sync to a backup remote.");
  }
  if (status !== "unlocked" && status !== "locked") {
    throw new Error("There is no vault to back up.");
  }
  const headerRaw = readPlaintextFile(tomb, HEADER_PATH);
  const body = readSealedFile(tomb, BODY_PATH);
  if (!headerRaw || !body) {
    throw new Error("There is nothing stored to back up yet.");
  }
  const header: VaultHeader = overlapCast(JSON.parse(headerRaw));
  const sealedBody: SealedBlob = body;
  const envelope = buildOfflineBackup({
    projectId: tomb === "personal" ? null : tomb,
    header,
    body: sealedBody,
  });
  return serializeOfflineBackup(envelope);
}
