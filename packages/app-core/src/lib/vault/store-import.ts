/**
 * Restoring an OpenSesame backup or sealed export into the open vault.
 *
 * Split out of `store.ts`: the store decides when an import runs; this file
 * opens the file, merges what it holds, and decides what becomes of the device
 * identity key it carried (ADR 0160 §5a).
 *
 * A backup is whatever its author wrote, header and body alike, so nothing in
 * it ranks against a key this vault holds. The backup's key is taken only when
 * the person asks for it and the vault has done nothing yet; otherwise it is
 * ignored and the vault keeps its principal.
 *
 * A key taken that way has to outlast the next sync. Another device of this
 * vault still holds the key it replaced, and a merge keeps the older of two
 * keys, so the key taken is dated just before the one it replaced (inside the
 * vault's window, `deviceKeyTimeBounds`): the person's choice outranks the
 * key it replaced on every device that knows it. A key some third device minted
 * earlier and has not yet synced still ranks first; that is the same rule every
 * two keys meet under, and the person is told when it happens.
 */

import { isString, overlapCast } from "@opensesame/os-domain";
import {
  type DeviceIdentityKeyRecord,
  type DeviceKeyTimeBounds,
  type SealedBlob,
  type VaultBody,
  type VaultHeader,
  clampDeviceKeyTime,
  deviceKeyField,
  deviceKeyTimeBounds,
  importVaultKey,
  normalizeVaultBody,
  outsideAccounts,
  syncInstalledTypes,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { lockManager } from "../../ports.js";
import type { IdentityChange } from "../device-identity-carry.js";
import { BODY_PATH, readSealedFile } from "../vfs.js";
import { recordItemTypes } from "./body-edits.js";
import { unwrapExportedVaultKey } from "./offline-backup-file.js";
import { openJsonForRebind } from "./seal-rebind.js";
import { type VaultBodyPort, levelDeviceKey } from "./store-device-key.js";

/** What a person decided about a restore. */
export type ImportOptions = Readonly<{
  /**
   * Take the backup's device identity key as this vault's. Honoured only for a
   * vault that has done nothing yet, and only when the person chose it.
   */
  adoptIdentity?: boolean;
}>;

/** The sealed backup `VaultStore.exportSealed` writes. */
export function sealedVaultExport(
  header: VaultHeader | null,
  tomb: string,
): string {
  if (!header) throw new Error("There is no vault to export.");
  const body = readSealedFile(tomb, BODY_PATH);
  if (!body) throw new Error("There is nothing stored to export yet.");
  return JSON.stringify(
    {
      format: "opensesame-vault-export",
      v: 1,
      exportedAt: new Date().toISOString(),
      tomb,
      header,
      body,
    },
    null,
    2,
  );
}

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
export function isFreshVault(body: VaultBody): boolean {
  return body.items.length === 0 && body.folders.length === 0;
}

/** Add what the backup holds and this vault does not, to `body`; returns how many items. */
function mergeItemsInto(body: VaultBody, incoming: VaultBody): number {
  const have = new Set(body.items.map((item) => item.id));
  const items = (incoming.items ?? []).filter((item) => !have.has(item.id));
  const folderIds = new Set(body.folders.map((folder) => folder.id));
  const folders = (incoming.folders ?? []).filter(
    (folder) => !folderIds.has(folder.id),
  );
  // Carry the export's definitions too, or the import lands items nothing here can read.
  const types = incoming.itemTypes ?? {};
  body.items = [...body.items, ...items];
  body.folders = [...body.folders, ...folders];
  const added = Object.keys(types).filter(
    (id) => body.itemTypes?.[id] === undefined,
  );
  recordItemTypes(body, { ...types, ...body.itemTypes }, { added });
  // An account's credentials are counted with it (ADR 0179).
  return outsideAccounts(items).length;
}

/**
 * Import a sealed export with its password, its PIN, or an unwrapped key.
 * Returns how many items it added.
 */
export async function importSealedInto(
  port: VaultBodyPort,
  fileText: string,
  secret: string | Uint8Array,
  options: ImportOptions = {},
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
  // An export from before ADR 0172 carries `login` items; they land as accounts.
  const incoming = normalizeVaultBody(opened.value);
  if (!port.open()) throw new Error("Unlock this vault before importing.");

  // Whether to look at the backup's key at all is decided before anything is
  // merged: only a vault that carries a key and has Web Locks to fence it, that
  // has done nothing yet, and only on request.
  const adopting =
    options.adoptIdentity === true &&
    port.carries() &&
    lockManager() !== undefined &&
    isFreshVault(port.body());
  if (!adopting) return mergeAndCount(port, incoming);

  const { vetCarriedKey } = await import("../device-identity-trust.js");
  const carried = await vetCarriedKey(incoming.deviceIdentityKey);
  if (carried.kind === "trusted") {
    const outcome = await importWithKey(port, incoming, carried.record);
    if (outcome.added !== null) return outcome.added;
    // This device's own record cannot be read, so it is never replaced: the
    // backup's key is fine, and it is not taken. Say that, not the opposite.
    const added = await mergeAndCount(port, incoming);
    await tell("own-unreadable");
    return added;
  }
  const added = await mergeAndCount(port, incoming);
  if (carried.kind === "absent") await mintAfterKeylessRestore(port);
  else await tell("restored-unusable");
  return added;
}

async function mergeAndCount(
  port: VaultBodyPort,
  incoming: VaultBody,
): Promise<number> {
  let added = 0;
  await port.mutate((body) => {
    added = mergeItemsInto(body, incoming);
  });
  syncInstalledTypes(port.body().itemTypes);
  return added;
}

async function tell(cause: IdentityChange): Promise<void> {
  const { noteDeviceIdentityChanged } = await import(
    "../device-identity-carry.js"
  );
  noteDeviceIdentityChanged(cause);
}

/** How many items a keyed restore added; null when the tomb's record is not replaceable. */
type ImportWithKey = Readonly<{ added: number | null }>;

/**
 * The key a restore takes, dated to outrank the one it replaces: just before
 * it (so a merge on any device that holds the old key keeps this one), never
 * after the backup's own date, and inside the vault's window. The same key
 * as the tomb's is kept as the tomb holds it.
 */
function takenKey(
  record: DeviceIdentityKeyRecord,
  previous: DeviceIdentityKeyRecord | null,
  bounds: DeviceKeyTimeBounds,
): DeviceIdentityKeyRecord {
  if (previous?.keyId === record.keyId)
    return clampDeviceKeyTime(previous, bounds);
  const replaced = previous ? clampDeviceKeyTime(previous, bounds) : null;
  const createdAt = Math.min(
    record.createdAt,
    replaced ? replaced.createdAt - 1 : record.createdAt,
  );
  return clampDeviceKeyTime({ ...record, createdAt }, bounds);
}

/**
 * The person took the backup's key. The tomb's file and the body (with the
 * items) change as one step under the identity lock: the tomb's key is written
 * first and put back if the body cannot be written, so a failed restore leaves
 * the vault as it was and says so, rather than leaving the two halves apart.
 * `added` is null when the tomb holds a record this build cannot read, which
 * is never replaced; nothing was written then.
 */
async function importWithKey(
  port: VaultBodyPort,
  incoming: VaultBody,
  record: DeviceIdentityKeyRecord,
): Promise<ImportWithKey> {
  const keys = await import("../device-identity-key.js");
  const tomb = port.tomb();
  const outcome = await keys.withDeviceIdentityFence(tomb, async () => {
    let previous: DeviceIdentityKeyRecord | null;
    try {
      previous = await keys.readStoredDeviceIdentityKey(tomb);
    } catch {
      return { added: null, replaced: false };
    }
    const taken = takenKey(
      record,
      previous,
      deviceKeyTimeBounds(port.header()?.createdAt),
    );
    if (previous?.keyId !== record.keyId) {
      await keys.writeStoredDeviceIdentityKey(tomb, taken);
    }
    let added = 0;
    try {
      await port.mutate((body) => {
        // Another tab may have given the vault something since this one looked.
        if (!isFreshVault(body)) {
          throw new Error(
            "This vault changed in another tab. Restore the backup again.",
          );
        }
        added = mergeItemsInto(body, incoming);
        body.deviceIdentityKey = deviceKeyField(taken);
      });
    } catch (error) {
      await keys.restoreStoredDeviceIdentityKey(tomb, previous);
      throw error;
    }
    return {
      added,
      replaced: previous !== null && previous.keyId !== record.keyId,
    };
  });
  syncInstalledTypes(port.body().itemTypes);
  if (outcome.replaced) await tell("restored");
  return { added: outcome.added };
}

/**
 * A backup that carried no key was restored, at the person's request, into a
 * vault that had done nothing: this vault's principal is its own, not the
 * backup's. Minted once, under the lock, and said so. With no lock to mint
 * under there is no key to report.
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
  await tell("restored-without-key");
}
