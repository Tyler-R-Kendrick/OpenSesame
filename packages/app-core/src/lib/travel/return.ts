/**
 * Return: put departed vaults back from their bundle and return code
 * (ADR 0143).
 *
 * `openReturn` reads the bundle and says, vault by vault, what would happen;
 * `completeReturn` does it. A vault comes home exactly as it left — every
 * file byte for byte, and any stray file of its tomb that the bundle does not
 * hold is removed — unless this device already has a vault under that id.
 * Then nothing is written: the same files are reported already home, and
 * anything else (a personal vault sealed on the road, or one changed since
 * it came back) is left alone. Returning the same bundle twice never undoes
 * what happened after the first return.
 */

import {
  TravelBundleError,
  type TravelBundleErrorCode,
  type TravelFile,
  type TravelPayload,
  type TravelVaultKind,
  openTravelBundle,
} from "./bundle-format.js";
import {
  type TravelDeps,
  type TravelGateRefusal,
  travelGate,
} from "./depart.js";
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
  | TravelGateRefusal
  | "code_malformed";

export type OpenReturnOutcome =
  | { ok: true; opened: OpenedReturn }
  | { ok: false; code: ReturnRefusal; message: string };

export type ReturnReceipt = Readonly<{
  restored: readonly string[];
  alreadyHome: readonly string[];
  occupied: readonly string[];
  writtenFiles: number;
}>;

export type CompleteReturnOutcome =
  | { ok: true; receipt: ReturnReceipt }
  | { ok: false; code: TravelGateRefusal };

const GATE_MESSAGE = {
  owner_not_present: "Open one of your own vaults first.",
  duress_active: "Not while a duress response holds this device.",
  storage_not_durable: "This browser is not keeping files for this site.",
} satisfies Record<TravelGateRefusal, string>;

function headerOf(id: string): string {
  return `${tombStem(id)}header.json`;
}

/**
 * What returning `vault` would do, read from the device now. Any vault
 * already here under that id is never written over: the same files are
 * already home, anything else (sealed on the road, or changed since it came
 * back) is left alone.
 */
async function statusOf(
  deps: TravelDeps,
  vault: TravelPayload["vaults"][number],
  present: readonly string[],
): Promise<ReturnStatus> {
  if ((await deps.storage.read(headerOf(vault.id))) === null) {
    return "comes_home";
  }
  for (const entry of vault.files) {
    if ((await deps.storage.read(entry.file)) !== entry.text) {
      return "occupied";
    }
  }
  const tombs = [...deps.storage.tombs(), vault.id];
  const extra = filesOfVault(vault.id, present, tombs).filter(
    (file) => !vault.files.some((entry) => entry.file === file),
  );
  return extra.length === 0 ? "already_home" : "occupied";
}

async function statusesOf(
  deps: TravelDeps,
  payload: TravelPayload,
): Promise<Map<string, ReturnStatus>> {
  const present = await deps.storage.listFiles();
  const out = new Map<string, ReturnStatus>();
  for (const vault of payload.vaults) {
    out.set(vault.id, await statusOf(deps, vault, present));
  }
  return out;
}

/** Open a bundle with its code and preview the return. Writes nothing. */
export async function openReturn(
  deps: TravelDeps,
  input: { bundleJson: string; returnCode: string },
): Promise<OpenReturnOutcome> {
  const refused = await travelGate(deps);
  if (refused) {
    return { ok: false, code: refused, message: GATE_MESSAGE[refused] };
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
  // Every vault leaves with its header; one without is not a vault.
  if (
    payload.vaults.some(
      (vault) =>
        !vault.files.some((entry) => entry.file === headerOf(vault.id)),
    )
  ) {
    return {
      ok: false,
      code: "bundle_malformed",
      message: "Not a travel bundle.",
    };
  }
  const statuses = await statusesOf(deps, payload);
  const vaults: ReturningVault[] = payload.vaults.map((vault) => ({
    id: vault.id,
    kind: vault.kind,
    name: vault.name,
    files: vault.files.length,
    status: statuses.get(vault.id) ?? "occupied",
  }));
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

/**
 * Restore every vault that still comes home. The gates and each vault's
 * status are read again here, not taken from the preview: the device may
 * have changed while the preview was on screen.
 */
export async function completeReturn(
  deps: TravelDeps,
  opened: OpenedReturn,
): Promise<CompleteReturnOutcome> {
  const refused = await travelGate(deps);
  if (refused) return { ok: false, code: refused };
  const status = await statusesOf(deps, opened.payload);
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
    // The header goes last: a return cut short leaves no header, so the
    // next attempt still sees the vault as coming home and finishes it.
    const header = headerOf(vault.id);
    const ordered = [
      ...vault.files.filter((entry) => entry.file !== header),
      ...vault.files.filter((entry) => entry.file === header),
    ];
    for (const entry of ordered) {
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
    [...status].filter(([, value]) => value === wanted).map(([id]) => id);
  return {
    ok: true,
    receipt: {
      restored,
      alreadyHome: pick("already_home"),
      occupied: pick("occupied"),
      writtenFiles,
    },
  };
}
