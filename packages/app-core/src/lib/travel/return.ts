/**
 * Return: put departed vaults back from their bundle and return code
 * (ADR 0140).
 *
 * `openReturn` reads the bundle and says, vault by vault, what would happen;
 * `completeReturn` does it. A vault comes home exactly as it left — every
 * file byte for byte, and any stray file of its tomb that the bundle does not
 * hold is removed — unless this device already has a different vault under
 * that id (a personal vault sealed on the road): that one is left alone and
 * reported, never overwritten. Returning the same bundle twice is harmless.
 */

import {
  TravelBundleError,
  type TravelBundleErrorCode,
  type TravelFile,
  type TravelPayload,
  type TravelVaultKind,
  openTravelBundle,
} from "./bundle-format.js";
import type { TravelDeps } from "./depart.js";
import { ReturnCodeError, parseReturnCode } from "./return-code.js";
import { filesOfVault, tombStem, vaultNamespace } from "./storage.js";

export type ReturnStatus =
  /** Nothing of it is on this device: it will be restored. */
  | "comes_home"
  /** Already restored, file for file. */
  | "already_home"
  /** A different vault sealed here under the same id; left untouched. */
  | "occupied";

export type ReturningVault = Readonly<{
  id: string;
  kind: TravelVaultKind;
  name: string | null;
  files: number;
  status: ReturnStatus;
}>;

export type ReturnPreview = Readonly<{
  bundleId: string;
  departedAt: string;
  vaults: readonly ReturningVault[];
}>;

export type OpenedReturn = Readonly<{
  preview: ReturnPreview;
  payload: TravelPayload;
}>;

export type ReturnRefusal =
  | TravelBundleErrorCode
  | "code_malformed"
  | "owner_not_present"
  | "duress_active"
  | "storage_not_durable";

export type OpenReturnOutcome =
  | { ok: true; opened: OpenedReturn }
  | { ok: false; code: ReturnRefusal; message: string };

export type ReturnReceipt = Readonly<{
  restored: readonly string[];
  alreadyHome: readonly string[];
  occupied: readonly string[];
  writtenFiles: number;
}>;

function headerFile(id: string, files: readonly TravelFile[]) {
  const header = `${tombStem(id)}header.json`;
  return files.find((entry) => entry.file === header) ?? null;
}

async function statusOf(
  deps: TravelDeps,
  vault: TravelPayload["vaults"][number],
  present: readonly string[],
): Promise<ReturnStatus> {
  const header = headerFile(vault.id, vault.files);
  const onDevice = header ? await deps.storage.read(header.file) : null;
  if (onDevice === null) return "comes_home";
  if (onDevice !== header?.text) return "occupied";
  for (const entry of vault.files) {
    if ((await deps.storage.read(entry.file)) !== entry.text) {
      return "comes_home";
    }
  }
  const tombs = [...deps.storage.tombs(), vault.id];
  const extra = filesOfVault(vault.id, present, tombs).filter(
    (file) => !vault.files.some((entry) => entry.file === file),
  );
  return extra.length === 0 ? "already_home" : "comes_home";
}

/** Open a bundle with its code and preview the return. Writes nothing. */
export async function openReturn(
  deps: TravelDeps,
  input: { bundleJson: string; returnCode: string },
): Promise<OpenReturnOutcome> {
  if (!deps.ownerPresent()) {
    return {
      ok: false,
      code: "owner_not_present",
      message: "Open one of your own vaults first.",
    };
  }
  if (await deps.duressActive()) {
    return {
      ok: false,
      code: "duress_active",
      message: "Not while a duress response holds this device.",
    };
  }
  if (!deps.storage.durable()) {
    return {
      ok: false,
      code: "storage_not_durable",
      message: "This browser is not keeping files for this site.",
    };
  }
  let payload: TravelPayload;
  try {
    const secret = await parseReturnCode(input.returnCode);
    payload = await openTravelBundle(
      input.bundleJson,
      secret,
      vaultNamespace(deps.storage.tombs()),
    );
  } catch (error) {
    if (
      error instanceof ReturnCodeError ||
      error instanceof TravelBundleError
    ) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
  const present = await deps.storage.listFiles();
  const vaults: ReturningVault[] = [];
  for (const vault of payload.vaults) {
    vaults.push({
      id: vault.id,
      kind: vault.kind,
      name: vault.name,
      files: vault.files.length,
      status: await statusOf(deps, vault, present),
    });
  }
  return {
    ok: true,
    opened: {
      preview: {
        bundleId: payload.bundleId,
        departedAt: payload.departedAt,
        vaults,
      },
      payload,
    },
  };
}

/** Restore every vault the preview said comes home. */
export async function completeReturn(
  deps: TravelDeps,
  opened: OpenedReturn,
): Promise<ReturnReceipt> {
  const status = new Map(
    opened.preview.vaults.map((vault) => [vault.id, vault.status]),
  );
  const restored: string[] = [];
  let writtenFiles = 0;
  const present = await deps.storage.listFiles();
  const touched = new Set<string>();
  for (const vault of opened.payload.vaults) {
    if (status.get(vault.id) !== "comes_home") continue;
    const tombs = [...deps.storage.tombs(), vault.id];
    const keep = new Set(vault.files.map((entry) => entry.file));
    for (const stray of filesOfVault(vault.id, present, tombs)) {
      if (keep.has(stray)) continue;
      await deps.storage.remove(stray);
      touched.add(stray);
    }
    for (const entry of vault.files) {
      await deps.storage.write(entry.file, entry.text);
      touched.add(entry.file);
      writtenFiles += 1;
    }
    await deps.storage.registerTomb(vault.id);
    restored.push(vault.id);
  }
  // Memory may hold what this device had under these names before; the
  // files are the truth now, and the welcome re-reads them.
  deps.storage.forget(touched);
  if (restored.length > 0) await deps.welcomeVaults(restored);
  const pick = (wanted: ReturnStatus) =>
    opened.preview.vaults
      .filter((vault) => vault.status === wanted)
      .map((vault) => vault.id);
  return {
    restored,
    alreadyHome: pick("already_home"),
    occupied: pick("occupied"),
    writtenFiles,
  };
}
