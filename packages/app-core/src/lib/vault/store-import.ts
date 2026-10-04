/**
 * Restoring an OpenSesame backup or sealed export into the open vault.
 *
 * Split out of `store.ts`: the store decides when an import runs; this file
 * opens the file, merges what it holds, and decides what becomes of the device
 * identity key it carried (ADR 0160 §5, `keyForRestore`).
 */

import { isString, overlapCast } from "@opensesame/os-domain";
import {
  type SealedBlob,
  type VaultBody,
  type VaultHeader,
  importVaultKey,
  syncInstalledTypes,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { BODY_PATH } from "../vfs.js";
import { recordItemTypes } from "./body-edits.js";
import { unwrapExportedVaultKey } from "./offline-backup-file.js";
import { openJsonForRebind } from "./seal-rebind.js";
import { type VaultBodyPort, levelDeviceKey } from "./store-device-key.js";

type ParsedExport = { header: VaultHeader; body: SealedBlob; tomb: string };

function parseExport(fileText: string): ParsedExport {
  let parsed: {
    format?: string;
    tomb?: string;
    header?: VaultHeader;
    body?: SealedBlob;
  };
  try {
    parsed = overlapCast(JSON.parse(fileText));
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (
    parsed.format !== "opensesame-vault-export" ||
    !parsed.header ||
    !parsed.body
  ) {
    throw new Error("That file is not an OpenSesame vault export.");
  }
  return {
    header: parsed.header,
    body: parsed.body,
    tomb: isString(parsed.tomb) ? parsed.tomb : "",
  };
}

/** A vault that has done nothing yet: no item, live or trashed, and no folder. */
function isFresh(body: VaultBody): boolean {
  return body.items.length === 0 && body.folders.length === 0;
}

/**
 * Import a sealed export with its password, its PIN, or an unwrapped key.
 * Returns how many items it added.
 */
export async function importSealedInto(
  port: VaultBodyPort,
  fileText: string,
  secret: string | Uint8Array,
): Promise<number> {
  const parsed = parseExport(fileText);
  const raw = await unwrapExportedVaultKey(parsed.header, secret);
  const key = await importVaultKey(raw);
  raw.fill(0);
  const tomb = parsed.tomb.length > 0 ? parsed.tomb : port.tomb();
  const opened = await openJsonForRebind<VaultBody>(
    key,
    parsed.body,
    vaultSealBinding(tomb, BODY_PATH),
  );
  const incoming = opened.value;

  if (!port.open()) throw new Error("Unlock this vault before importing.");
  const current = port.body();
  const existing = new Set(current.items.map((item) => item.id));
  const merged = (incoming.items ?? []).filter(
    (item) => !existing.has(item.id),
  );
  const folderIds = new Set(current.folders.map((folder) => folder.id));
  const mergedFolders = (incoming.folders ?? []).filter(
    (folder) => !folderIds.has(folder.id),
  );
  // Carry the export's definitions too, or the import lands items nothing here can read.
  const incomingTypes = incoming.itemTypes ?? {};
  // Read before anything is merged: whether this vault had done anything yet
  // is what tells a restore from an import of someone else's items.
  const carries = port.carries();
  const plan = carries
    ? (await import("../device-identity-carry.js")).keyForRestore({
        local: current.deviceIdentityKey,
        incoming: incoming.deviceIdentityKey,
        sameVault: parsed.header.createdAt === port.header()?.createdAt,
        fresh: isFresh(current),
      })
    : null;
  await port.mutate((body) => {
    body.items = [...body.items, ...merged];
    body.folders = [...body.folders, ...mergedFolders];
    const added = Object.keys(incomingTypes).filter(
      (id) => body.itemTypes?.[id] === undefined,
    );
    recordItemTypes(body, { ...incomingTypes, ...body.itemTypes }, { added });
    if (plan) body.deviceIdentityKey = plan.field;
  });
  syncInstalledTypes(port.body().itemTypes);
  if (plan) {
    await levelDeviceKey(
      port,
      plan.prefer === "carried" ? { prefer: "carried" } : {},
    );
    if (plan.withoutKey) await mintAfterKeylessRestore(port);
  }
  return merged.length;
}

/**
 * A backup that carried no key was restored into a vault that had done
 * nothing: this vault's principal is its own, not the backup's. Minted once,
 * under the lock, and said so. With no lock to mint under there is no key to
 * report.
 */
async function mintAfterKeylessRestore(port: VaultBodyPort): Promise<void> {
  const { ensureDeviceIdentityKey } = await import("../device-identity-key.js");
  try {
    await ensureDeviceIdentityKey(port.tomb());
  } catch {
    return;
  }
  // Whatever the carrier port could not reach, the store's own port can.
  await levelDeviceKey(port);
  const { noteDeviceIdentityChanged } = await import(
    "../device-identity-carry.js"
  );
  noteDeviceIdentityChanged("restored-without-key");
}
