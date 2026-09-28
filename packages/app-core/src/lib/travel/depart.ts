/**
 * Departure: pack the vaults that are not safe for travel, then take them
 * off this device (ADR 0143).
 *
 * Two steps, on purpose. `packDeparture` writes nothing: it reads every file
 * of every departing vault, seals them into a bundle under a fresh return
 * code, and proves the bundle opens with that code and holds exactly what
 * was read. Only after the person says both the bundle and the code are
 * somewhere else does `completeDeparture` remove anything — and it re-reads
 * the files and the plan first, so a vault that changed in between, or that
 * became the open vault, is never removed against a bundle that does not
 * hold its latest state. A removal cut short can be finished with the same
 * package: every file still here must be one the bundle holds, byte for byte.
 */

import { sha256Hex } from "../capabilities/trust/digest.js";
import {
  type TravelFile,
  type TravelVault,
  bundleFileName,
  newBundleId,
  openTravelBundle,
  sealTravelBundle,
} from "./bundle-format.js";
import { type PlannableVault, type TravelPlan, planTravel } from "./plan.js";
import {
  formatReturnCode,
  mintReturnSecret,
  parseReturnCode,
} from "./return-code.js";
import {
  type TravelStorage,
  filesOfVault,
  headerOf,
  vaultNamespace,
} from "./storage.js";

export type TravelVaultInfo = PlannableVault &
  Readonly<{ label: string; name: string | null }>;

export type TravelDeps = Readonly<{
  storage: TravelStorage;
  vaults: () => readonly TravelVaultInfo[];
  /** True while a duress incident holds this device (ADR 0130). */
  duressActive: () => Promise<boolean>;
  /** A vault of the owner's is open — not a guest session, not locked. */
  ownerPresent: () => boolean;
  /**
   * Projects whose vault still sits under the pre-tomb keys. The vault list
   * reports them as empty, so a plan could neither send them off nor keep
   * them; they are refused until opened once (which moves them).
   */
  legacyVaults: () => Promise<readonly string[]>;
  /** Drop departed vaults from the projects list and the active pointer. */
  forgetVaults: (ids: readonly string[]) => Promise<void>;
  /** Pick up vaults that came home (hydrate headers, rebuild the list). */
  welcomeVaults: (
    vaults: readonly Pick<TravelVault, "id" | "kind" | "name">[],
  ) => Promise<void>;
  now: () => Date;
}>;

/** What stops travel in either direction, checked at every step that writes. */
export type TravelGateRefusal =
  | "owner_not_present"
  | "duress_active"
  | "storage_not_durable";

export type DepartureRefusal =
  | TravelGateRefusal
  | "vault_needs_opening"
  | "unknown_vault"
  | "open_vault_departs"
  | "nothing_departs"
  | "vault_has_no_files"
  | "self_check_failed";

export type DepartingVault = Readonly<{
  id: string;
  label: string;
  files: number;
  bytes: number;
}>;

export type DeparturePackage = Readonly<{
  bundleId: string;
  bundleJson: string;
  bundleFileName: string;
  /** Shown once. Never written to this device. */
  returnCode: string;
  plan: TravelPlan;
  departing: readonly DepartingVault[];
  /** Per vault, each packed file's SHA-256: what a removal may take. */
  packed: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>;

export type PackOutcome =
  | { ok: true; pkg: DeparturePackage }
  | { ok: false; code: DepartureRefusal; ids: readonly string[] };

export type DepartureReceipt = Readonly<{
  departed: readonly string[];
  removedFiles: number;
  /** Files still present after removal; empty when the removal held. */
  leftovers: readonly string[];
  completion: "applied_local" | "incomplete";
  /** Not a forensic wipe: what the browser deleted is all this claims. */
  assurance: "application_scoped_removal";
}>;

export type CompleteOutcome =
  | { ok: true; receipt: DepartureReceipt }
  | {
      ok: false;
      code:
        | TravelGateRefusal
        | "not_acknowledged"
        | "changed_since_packed"
        | "open_vault_departs";
    };

function digestOf(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

async function digestsOf(
  vaults: readonly Pick<TravelVault, "id" | "files">[],
): Promise<DeparturePackage["packed"]> {
  const out: Record<string, Record<string, string>> = {};
  for (const vault of vaults) {
    const entries = await Promise.all(
      vault.files.map(async (entry) => [
        entry.file,
        await digestOf(entry.text),
      ]),
    );
    out[vault.id] = Object.fromEntries(entries);
  }
  return out;
}

async function readVaultFiles(
  storage: TravelStorage,
  ids: readonly string[],
): Promise<Map<string, TravelFile[]>> {
  const all = await storage.listFiles();
  const tombs = storage.tombs();
  const out = new Map<string, TravelFile[]>();
  for (const id of ids) {
    const read = await Promise.all(
      filesOfVault(id, all, tombs).map(async (file) => ({
        file,
        text: await storage.read(file),
      })),
    );
    out.set(
      id,
      read.filter((entry): entry is TravelFile => entry.text !== null),
    );
  }
  return out;
}

function kindOf(vault: TravelVaultInfo): "personal" | "project" {
  return vault.kind === "personal" ? "personal" : "project";
}

export async function travelGate(
  deps: TravelDeps,
): Promise<TravelGateRefusal | null> {
  if (!deps.ownerPresent()) return "owner_not_present";
  if (await deps.duressActive()) return "duress_active";
  if (!deps.storage.durable()) return "storage_not_durable";
  return null;
}

/** Read, seal and self-check. Removes nothing. */
export async function packDeparture(
  deps: TravelDeps,
  input: { safe: readonly string[] },
): Promise<PackOutcome> {
  const refused = await travelGate(deps);
  if (refused) return { ok: false, code: refused, ids: [] };
  const legacy = await deps.legacyVaults();
  if (legacy.length > 0) {
    return { ok: false, code: "vault_needs_opening", ids: legacy };
  }
  const vaults = deps.vaults();
  const planned = planTravel({ vaults, safe: input.safe });
  if (!planned.ok) return planned;
  const { plan } = planned;
  const files = await readVaultFiles(deps.storage, plan.departing);
  const empty = plan.departing.filter((id) => !files.get(id)?.length);
  if (empty.length > 0) {
    return { ok: false, code: "vault_has_no_files", ids: empty };
  }
  const byId = new Map(vaults.map((vault) => [vault.id, vault]));
  const carried: TravelVault[] = plan.departing.map((id) => {
    const vault = byId.get(id);
    return {
      id,
      kind: vault ? kindOf(vault) : "project",
      name: vault?.name ?? null,
      files: files.get(id) ?? [],
    };
  });
  const bundleId = newBundleId();
  const secret = mintReturnSecret();
  const returnCode = await formatReturnCode(secret);
  const bundleJson = await sealTravelBundle(
    {
      v: 1,
      bundleId,
      departedAt: deps.now().toISOString(),
      vaults: carried,
    },
    secret,
  );
  const packed = await digestsOf(carried);
  // Prove the round trip before anyone is told the bundle is safe to rely
  // on: the code as displayed opens it, and it holds what was read.
  try {
    const reopened = await openTravelBundle(
      bundleJson,
      await parseReturnCode(returnCode),
      vaultNamespace(deps.storage.tombs()),
    );
    const reread = await digestsOf(reopened.vaults);
    if (JSON.stringify(reread) !== JSON.stringify(packed)) {
      return { ok: false, code: "self_check_failed", ids: [] };
    }
  } catch {
    return { ok: false, code: "self_check_failed", ids: [] };
  }
  return {
    ok: true,
    pkg: {
      bundleId,
      bundleJson,
      bundleFileName: bundleFileName(bundleId),
      returnCode,
      plan,
      departing: carried.map((vault) => ({
        id: vault.id,
        label: byId.get(vault.id)?.label ?? vault.id,
        files: vault.files.length,
        bytes: vault.files.reduce((sum, entry) => sum + entry.text.length, 0),
      })),
      packed,
    },
  };
}

/**
 * Why the package can no longer be trusted to remove what it packed: a
 * departing vault is open now, or a vault neither staying nor departing was
 * sealed since, or a departing file is one the bundle does not hold as it
 * is. A file the bundle holds may be missing — a removal cut short, at the
 * header or anywhere after it — and the rest of it still goes.
 */
async function staleSincePacked(
  deps: TravelDeps,
  pkg: DeparturePackage,
  current: ReadonlyMap<string, readonly TravelFile[]>,
): Promise<"changed_since_packed" | "open_vault_departs" | null> {
  const departing = new Set(pkg.plan.departing);
  const staying = new Set(pkg.plan.staying);
  for (const vault of deps.vaults()) {
    if (vault.kind === "guest" || vault.state === "empty") continue;
    if (departing.has(vault.id) && vault.state === "open") {
      return "open_vault_departs";
    }
    if (!departing.has(vault.id) && !staying.has(vault.id)) {
      return "changed_since_packed";
    }
  }
  const checks = pkg.plan.departing.flatMap((id) =>
    (current.get(id) ?? []).map(
      async (entry) =>
        pkg.packed[id]?.[entry.file] === (await digestOf(entry.text)),
    ),
  );
  return (await Promise.all(checks)).every(Boolean)
    ? null
    : "changed_since_packed";
}

/**
 * Remove every file, header first: a departure cut short leaves a vault with
 * no header, which the bundle's return restores whole rather than refusing,
 * and which this package can finish. A file that will not go is reported,
 * not thrown past the files after it.
 */
async function removeAll(
  storage: TravelStorage,
  current: ReadonlyMap<string, readonly TravelFile[]>,
): Promise<Set<string>> {
  const removed = new Set<string>();
  for (const [id, files] of current) {
    const header = headerOf(id);
    const ordered = [
      ...files.filter((entry) => entry.file === header),
      ...files.filter((entry) => entry.file !== header),
    ];
    for (const entry of ordered) {
      try {
        await storage.remove(entry.file);
        removed.add(entry.file);
      } catch {
        // Counted as a leftover when the device is read back below.
      }
    }
  }
  return removed;
}

/**
 * Remove the departing vaults, once the person has said the bundle and the
 * return code are both somewhere other than this device.
 */
export async function completeDeparture(
  deps: TravelDeps,
  pkg: DeparturePackage,
  ack: { bundleSaved: boolean; codeRecorded: boolean },
): Promise<CompleteOutcome> {
  if (!ack.bundleSaved || !ack.codeRecorded) {
    return { ok: false, code: "not_acknowledged" };
  }
  // The device may have changed since packing: a duress incident, a lock.
  const refused = await travelGate(deps);
  if (refused) return { ok: false, code: refused };
  const ids = pkg.plan.departing;
  const current = await readVaultFiles(deps.storage, ids);
  const stale = await staleSincePacked(deps, pkg, current);
  if (stale) return { ok: false, code: stale };
  const removed = await removeAll(deps.storage, current);
  deps.storage.forget(removed);
  // Read the device back: the receipt reports what is actually gone, and
  // only a vault with nothing left leaves the registry and the list. One
  // cut short stays where the person can see it until this package, or the
  // bundle's return, finishes it.
  const after = await deps.storage.listFiles();
  const tombs = [...deps.storage.tombs(), ...ids];
  const left = new Map(ids.map((id) => [id, filesOfVault(id, after, tombs)]));
  const gone = ids.filter((id) => left.get(id)?.length === 0);
  for (const id of gone) await deps.storage.unregisterTomb(id);
  if (gone.length > 0) await deps.forgetVaults(gone);
  const leftovers = ids.flatMap((id) => left.get(id) ?? []);
  return {
    ok: true,
    receipt: {
      departed: ids,
      removedFiles: removed.size,
      leftovers,
      completion: leftovers.length === 0 ? "applied_local" : "incomplete",
      assurance: "application_scoped_removal",
    },
  };
}
