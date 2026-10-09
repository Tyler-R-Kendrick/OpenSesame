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
 * what happened after the first return. A vault this device still holds
 * part of, unchanged — a departure or return cut short — is finished.
 *
 * Site grants (`grants.ts`) are not the vault: they are left out of every
 * comparison. What lets a site in comes back only when the person asks;
 * what keeps a site out always does.
 */

import {
  TravelBundleError,
  type TravelBundleErrorCode,
  type TravelPayload,
  type TravelVaultKind,
  openTravelBundle,
} from "./bundle-format.js";
import {
  type TravelDeps,
  type TravelGateRefusal,
  travelGate,
} from "./depart.js";
import {
  type TravelGrants,
  grantsIn,
  isGrantFile,
  writeGrants,
} from "./grants.js";
import { ReturnCodeError, parseReturnCode } from "./return-code.js";
import { bodyOf, filesOfVault, headerOf, vaultNamespace } from "./storage.js";

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
  /** What its site grants would let in, were they brought back. */
  grants: TravelGrants;
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
  /** Restored vaults whose site grants came back too. */
  grantsRestored: readonly string[];
  alreadyHome: readonly string[];
  occupied: readonly string[];
  writtenFiles: number;
}>;

/** How a return treats what the bundle carries beyond the vault itself. */
export type ReturnOptions = Readonly<{
  /** Write the vault's site grants back, at the person's word. */
  grants: boolean;
}>;

const NO_GRANTS: ReturnOptions = { grants: false };

export type CompleteReturnOutcome =
  | { ok: true; receipt: ReturnReceipt }
  | { ok: false; code: TravelGateRefusal };

const GATE_MESSAGE = {
  owner_not_present: "Open one of your own vaults first.",
  duress_active: "Not while a duress response holds this device.",
  storage_not_durable: "This browser is not keeping files for this site.",
} satisfies Record<TravelGateRefusal, string>;

/** The vault's own files: everything it carries but its site grants. */
function vaultFiles(vault: TravelPayload["vaults"][number]) {
  return vault.files.filter((entry) => !isGrantFile(vault.id, entry.file));
}

/**
 * What returning `vault` would do, read from the device now. Any vault
 * already here under that id is never written over: the same files are
 * already home, anything else (sealed on the road, or changed since it came
 * back) is left alone. One whose body is gone while every file still here
 * matches the bundle is a removal cut short, and comes home.
 */
async function statusOf(
  deps: TravelDeps,
  vault: TravelPayload["vaults"][number],
  present: readonly string[],
): Promise<ReturnStatus> {
  const headerMissing = (await deps.storage.read(headerOf(vault.id))) === null;
  const files = vaultFiles(vault);
  const here = await Promise.all(
    files.map((entry) => deps.storage.read(entry.file)),
  );
  const tombs = [...deps.storage.tombs(), vault.id];
  const extra = filesOfVault(vault.id, present, tombs).filter(
    (file) =>
      !isGrantFile(vault.id, file) &&
      !files.some((entry) => entry.file === file),
  );
  const differs = files.some(
    (entry, i) => here[i] !== null && here[i] !== entry.text,
  );
  if (differs || extra.length > 0) return "occupied";
  // Without a header, every matching file still needs the header written;
  // only conflicting tomb files mean a different vault owns this id.
  if (headerMissing) return "comes_home";
  if (here.every((text) => text !== null)) return "already_home";
  const bodyGone = files.some(
    (entry, i) => entry.file === bodyOf(vault.id) && here[i] === null,
  );
  return bodyGone ? "comes_home" : "occupied";
}

async function statusesOf(
  deps: TravelDeps,
  payload: TravelPayload,
  present: readonly string[],
): Promise<Map<string, ReturnStatus>> {
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
  const statuses = await statusesOf(
    deps,
    payload,
    await deps.storage.listFiles(),
  );
  const vaults: ReturningVault[] = payload.vaults.map((vault) => ({
    id: vault.id,
    kind: vault.kind,
    name: vault.name,
    files: vaultFiles(vault).length,
    status: statuses.get(vault.id) ?? "occupied",
    grants: grantsIn(vault.id, vault.files),
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

/** What putting one vault back touched, and how many vault files it wrote. */
type RestoredVault = Readonly<{ touched: string[]; written: number }>;

/**
 * Put one vault back: its tomb registered first, so a return cut short
 * leaves leftovers the panel can see; strays gone; every file written, the
 * header last; then its grants, by the person's word (`grants.ts`).
 */
async function restoreVault(
  deps: TravelDeps,
  vault: TravelPayload["vaults"][number],
  present: readonly string[],
  grants: boolean,
): Promise<RestoredVault> {
  await deps.storage.registerTomb(vault.id);
  const touched: string[] = [];
  const files = vaultFiles(vault);
  const keep = new Set(files.map((entry) => entry.file));
  const tombs = [...deps.storage.tombs(), vault.id];
  for (const stray of filesOfVault(vault.id, present, tombs)) {
    if (keep.has(stray) || isGrantFile(vault.id, stray)) continue;
    await deps.storage.remove(stray);
    touched.push(stray);
  }
  // The header goes last: a return cut short leaves no header, so the next
  // attempt still sees the vault as coming home and finishes it.
  const header = headerOf(vault.id);
  const ordered = [
    ...files.filter((entry) => entry.file !== header),
    ...files.filter((entry) => entry.file === header),
  ];
  for (const entry of ordered) {
    await deps.storage.write(entry.file, entry.text);
    touched.push(entry.file);
  }
  touched.push(
    ...(await writeGrants(deps.storage, vault.id, vault.files, grants)),
  );
  return { touched, written: ordered.length };
}

/**
 * Restore every vault that still comes home. The gates and each vault's
 * status are read again here, not taken from the preview: the device may
 * have changed while the preview was on screen.
 */
export function completeReturn(
  deps: TravelDeps,
  opened: OpenedReturn,
  options: ReturnOptions = NO_GRANTS,
): Promise<CompleteReturnOutcome> {
  return deps.exclusive(async () => {
    const refused = await travelGate(deps);
    if (refused) return { ok: false, code: refused };
    const present = await deps.storage.listFiles();
    const status = await statusesOf(deps, opened.payload, present);
    const restored: string[] = [];
    const grantsRestored: string[] = [];
    let writtenFiles = 0;
    const touched = new Set<string>();
    for (const vault of opened.payload.vaults) {
      if (status.get(vault.id) !== "comes_home") continue;
      const done = await restoreVault(deps, vault, present, options.grants);
      for (const file of done.touched) touched.add(file);
      writtenFiles += done.written;
      restored.push(vault.id);
      if (options.grants && grantsIn(vault.id, vault.files).sites.length > 0) {
        grantsRestored.push(vault.id);
      }
    }
    // Memory may hold what this device had under these names before; the
    // files are the truth now, and the welcome re-reads them.
    deps.storage.forget(touched);
    // Names ride in the bundle: a vault that left took its name out of every
    // view on this device, and gets it back here.
    if (restored.length > 0) {
      await deps.welcomeVaults(
        opened.payload.vaults.filter((vault) => restored.includes(vault.id)),
      );
    }
    const pick = (wanted: ReturnStatus) =>
      [...status].filter(([, value]) => value === wanted).map(([id]) => id);
    return {
      ok: true,
      receipt: {
        restored,
        grantsRestored,
        alreadyHome: pick("already_home"),
        occupied: pick("occupied"),
        writtenFiles,
      },
    };
  });
}
