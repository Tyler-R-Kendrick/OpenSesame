/**
 * The sealed-store bridge's two halves in Pages (ADR 0037 §6): the store
 * path manifest `opensesame pass seal <file> --shred` reads, written from
 * the unlocked vault, and the same file read back through the Import sheet,
 * merged by store path so a second import changes nothing.
 *
 * The format is the Rust side's `ManifestEntry`
 * (`crates/sealed-store/src/manifest.rs`): a JSON array of
 * `{ path, secret, trailer }`. `spec/conformance/store-manifest.json` is the
 * one file both planes check themselves against (ADR 0139).
 */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type Folder,
  type VaultItem,
  outsideAccounts,
} from "@opensesame/vault-core";
import {
  type ManifestMergePlan,
  type StorePlainEntry,
  planManifestMerge,
  vaultItemToEntry,
} from "../../../lib/vault/store-sync.js";
import type { Fact } from "./preview.js";

export const STORE_MANIFEST_LABEL = "OpenSesame store path manifest";

/** The file the Sealed store key saves, and how many entries it holds. */
export type StoreManifestFile = Readonly<{
  fileName: string;
  text: string;
  count: number;
}>;

/** A manifest's merge, and how many paths it leaves alone by kind. */
export type ManifestPlan = ManifestMergePlan & Readonly<{ kept: number }>;

const ENTRY_KEYS = new Set(["path", "secret", "trailer"]);

/** One `ManifestEntry`, exactly: its three keys and nothing else. */
function entryOf(value: BoundaryValue): StorePlainEntry | null {
  if (!isJsonObject(value)) return null;
  const { path, secret, trailer } = value;
  if (!Object.keys(value).every((key) => ENTRY_KEYS.has(key))) return null;
  if (!isString(path) || pathKey(path) === "" || !isString(secret)) {
    return null;
  }
  if (trailer !== undefined && !isString(trailer)) return null;
  return { path, secret, trailer: trailer ?? "" };
}

function pathKey(path: string): string {
  return path
    .replace(/^\/+|\/+$/gu, "")
    .trim()
    .toLowerCase();
}

/**
 * A parsed JSON value read as a store path manifest, or `null` when it is
 * not one. Only an array whose every element is exactly an entry counts, so
 * another manager's JSON export is never mistaken for one. A path named
 * twice keeps its last entry — the one `pass seal` would leave sealed.
 */
export function readStoreManifest(
  json: BoundaryValue,
): StorePlainEntry[] | null {
  if (!Array.isArray(json) || json.length === 0) return null;
  const byPath = new Map<string, StorePlainEntry>();
  for (const value of json) {
    const entry = entryOf(value);
    if (entry === null) return null;
    byPath.delete(pathKey(entry.path));
    byPath.set(pathKey(entry.path), entry);
  }
  return [...byPath.values()];
}

/**
 * The merge a manifest would make. Every kind comes back as itself, but an
 * entry still never changes what kind of item already sits at its path: a
 * bare `pass` entry, or one naming a kind this build does not know, reads as
 * a login, and a card at that path is worth more than a guess — so the path
 * is left as it is. An entry that says what the item already says, in other
 * words (a `pass` trailer without the empty lists Pages writes, or a manifest
 * an older Pages saved), is unchanged, not updated — `planManifestMerge`
 * judges that by the item it would write — so a second import writes nothing.
 */
export function planStoreManifest(
  entries: StorePlainEntry[],
  items: VaultItem[],
  folders: Folder[],
): ManifestPlan {
  const plan = planManifestMerge(entries, items, folders);
  const byId = new Map(items.map((item) => [item.id, item]));
  const updates: VaultItem[] = [];
  let kept = 0;
  for (const update of plan.updates) {
    if (byId.get(update.id)?.kind !== update.kind) kept += 1;
    else updates.push(update);
  }
  return { ...plan, updates, kept };
}

export function manifestFacts(
  entries: readonly StorePlainEntry[],
  plan: ManifestPlan,
): Fact[] {
  const facts: Fact[] = [
    { key: "Format", value: STORE_MANIFEST_LABEL },
    { key: "Entries", value: String(entries.length) },
    { key: "New", value: String(plan.adds.length) },
  ];
  if (plan.updates.length > 0) {
    facts.push({ key: "Updated", value: String(plan.updates.length) });
  }
  if (plan.unchanged > 0) {
    facts.push({ key: "Already here", value: String(plan.unchanged) });
  }
  if (plan.kept > 0) {
    facts.push({ key: "Kept as is", value: String(plan.kept) });
  }
  if (plan.newFolders.length > 0) {
    facts.push({ key: "New folders", value: String(plan.newFolders.length) });
  }
  return facts;
}

/** The commit key's words: what the merge will actually write. */
export function manifestCommitLabel(plan: ManifestMergePlan): string {
  const writes = plan.adds.length + plan.updates.length;
  return writes === 0
    ? "Nothing to merge"
    : `Merge ${writes} ${writes === 1 ? "entry" : "entries"}`;
}

/** What the manifest export reads of the vault's state. */
export type ManifestSource = Readonly<{ status: string; guest: boolean }>;

/**
 * Why no manifest is offered now, or null when one is. The manifest is the
 * vault in plain text, private keys included, so it answers to the same
 * rules as the encrypted Export: an unlocked vault, never a guest's.
 */
export function manifestRefusal(
  vault: ManifestSource,
  count: number,
): string | null {
  if (vault.status !== "unlocked") return "Unlock to export";
  if (vault.guest) return "A guest vault is not exported";
  if (count === 0) return "Nothing to export";
  return null;
}

/**
 * The manifest file for the unlocked vault: every live item, as
 * `pass seal` reads it.
 */
export function storeManifestFile(
  items: readonly VaultItem[],
  folders: Folder[],
  now: Date = new Date(),
): StoreManifestFile {
  // A credential bound to an account rides in that account's entry (ADR 0177).
  const entries = outsideAccounts(
    items.filter((item) => item.deletedAt === null),
  ).map((item) => vaultItemToEntry(item, folders));
  return {
    fileName: `opensesame-store-manifest-${now.toISOString().slice(0, 10)}.json`,
    text: `${JSON.stringify(entries, null, 2)}\n`,
    count: entries.length,
  };
}
