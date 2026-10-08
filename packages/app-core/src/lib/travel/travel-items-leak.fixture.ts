/**
 * Fixtures for the leak walk over hiding items (ADR 0171): a vault seeded with
 * one distinctive string per place an item keeps something, and a reader that
 * collects every surface the owner's key can open.
 */

import {
  type Folder,
  type VaultBody,
  type VaultItem,
  createItem,
  manualPassword,
  openJson,
  unlockVaultKey,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { plainAccount } from "../account.test-support.js";
import {
  ACTIVITY_LOG_PATH,
  flushActivityLog,
  listActivityEvents,
} from "../activity-log.js";
import { resetHistoryBackupMemory } from "../history-backup-idb.js";
import { kvDelete, kvGet } from "../kv.js";
import { projectScopedKeys } from "../projects.js";
import { resetPasswordHistoryForTest } from "../vault/password-history.js";
import { vaultStore } from "../vault/store.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  listDir,
  readFile,
  readSealedFile,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { hideItemsForTravel, packTravelItemDeparture } from "./index.js";
import { travelItemSeams } from "./items-deps.js";

export const PASSWORD = "correct horse battery staple";
export const ACK = { bundleSaved: true, codeRecorded: true };

/** One distinctive string per place an item keeps something. */
export const S = {
  name: "Zebra Offshore Bank",
  username: "user-zebra-4c1",
  password: "pw-zebra-9f31", // gitleaks:allow — validated synthetic fixture or fixed non-secret identifier
  notes: "note-zebra-7c2",
  field: "field-zebra-3d9",
  totp: "KRSXG5CTMVRXEZLUKN2XG2LS",
  folder: "Folder-Zebra-Vault",
  trashName: "Quartz Trash Note",
  trashNotes: "trashnote-quartz-88e",
  histName: "Hist Mail Account",
  histOld: "oldpw-hist-5a1",
  histNew: "newpw-hist-6b2",
} as const;

export const KEEP = {
  name: "Keeper One",
  password: "pw-keeper-1-ab9",
  note: "Keeper Two",
} as const;

export type Seeded = {
  hide: string[];
  hidden: VaultItem[];
  before: VaultBody;
};

export async function clearTomb(): Promise<void> {
  vaultStore.lock();
  await vfsFlush();
  for (const tomb of [PERSONAL_TOMB, GUEST_TOMB]) {
    for (const path of [
      HEADER_PATH,
      BODY_PATH,
      INDEX_PATH,
      MIGRATION_MARKER_PATH,
      ACTIVITY_LOG_PATH,
    ]) {
      kvDelete(tombFileKey(tomb, path));
    }
  }
  resetPasswordHistoryForTest();
  resetHistoryBackupMemory();
}

/** The owner's vault key, derived from the master password the way unlock does. */
export async function ownerKey(): Promise<CryptoKey> {
  const header = vaultStore.getSnapshot().header;
  if (!header) throw new Error("no vault is open");
  return unlockVaultKey(header, PASSWORD);
}

export function bodyOf(): VaultBody {
  const { items, folders } = vaultStore.getSnapshot();
  return { v: 1, items: [...items], folders: [...folders] };
}

/** An open vault holding everything the strings above stand for. */
export async function seedVault(): Promise<Seeded> {
  await vaultStore.create(PASSWORD);
  const vault: Folder = await vaultStore.addFolder(S.folder);
  const bank = plainAccount(S.name, S.password, {
    username: S.username,
    totp: S.totp,
  });
  Object.assign(bank, {
    notes: S.notes,
    folderId: vault.id,
    fields: [{ id: "cf-1", name: "Account", value: S.field, hidden: true }],
  });
  const trashed = createItem("note", S.trashName);
  trashed.notes = S.trashNotes;
  const hist = plainAccount(S.histName, S.histOld);
  const keeper = plainAccount(KEEP.name, KEEP.password);
  const keeperNote = createItem("note", KEEP.note);
  await vaultStore.saveItems([bank, trashed, hist, keeper, keeperNote]);
  // A prior edit: the old password is retired, and an "updated" line is written.
  await vaultStore.saveItem({
    ...hist,
    methods: [
      manualPassword(
        `${hist.id}:password`,
        S.histNew,
        new Date().toISOString(),
      ),
    ],
  });
  await vaultStore.trashItem(trashed.id);
  await flushActivityLog();
  const items = vaultStore.getSnapshot().items;
  const find = (name: string) => {
    const item = items.find((i) => i.name === name);
    if (!item) throw new Error(`seed lost ${name}`);
    return item;
  };
  const hidden = [find(S.name), find(S.trashName), find(S.histName)];
  return {
    hide: hidden.map((item) => item.id),
    hidden,
    before: structuredClone(bodyOf()),
  };
}

export function useDurableStorage(): void {
  // The in-memory origin reports itself non-durable; hiding refuses there by
  // design (covered in travel-items.test.ts), so the leak walk lends it one.
  travelItemSeams.deps = {
    ...travelItemSeams.deps,
    storage: { durable: () => true },
  };
}

export async function hideThem(ids: string[]) {
  const packed = await packTravelItemDeparture(ids);
  if (!packed.ok) throw new Error(`pack refused: ${packed.code}`);
  const done = await hideItemsForTravel(packed.pkg, ACK);
  if (!done.ok) throw new Error(`hide refused: ${done.code}`);
  await flushActivityLog();
  return { pkg: packed.pkg, receipt: done.receipt };
}

/** Everything the device holds of one tomb that the owner's key can read. */
export async function readableSurfaces(tomb: string, key: CryptoKey) {
  const surfaces = new Map<string, string>();
  const sealed = readSealedFile(tomb, BODY_PATH);
  if (!sealed) throw new Error("no sealed body");
  const plain = await openJson<VaultBody>(
    key,
    sealed,
    vaultSealBinding(tomb, BODY_PATH),
  );
  surfaces.set("sealed body", JSON.stringify(plain));
  for (const path of await listDir(tomb, "")) {
    // The body is sealed verbatim, not by the tomb: read above.
    if (path === BODY_PATH) continue;
    const bytes = await readFile(tomb, path);
    surfaces.set(`tomb file ${path}`, new TextDecoder().decode(bytes));
  }
  // The files as the origin holds them, header and plaintext records included.
  const paths = [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    ...(await listDir(tomb, "")),
  ];
  for (const path of paths) {
    const raw = kvGet(tombFileKey(tomb, path));
    if (raw !== null) surfaces.set(`origin file ${path}`, raw);
  }
  for (const key of [
    ...projectScopedKeys(tomb),
    `vault.offline-ciphertext.v1:${tomb === PERSONAL_TOMB ? "_default" : tomb}`,
  ]) {
    const raw = kvGet(key);
    if (raw !== null) surfaces.set(`record ${key}`, raw);
  }
  const events = await listActivityEvents(tomb);
  surfaces.set("activity log", JSON.stringify(events));
  return { surfaces, plain };
}

export function leaks(
  surfaces: ReadonlyMap<string, string>,
  needles: readonly string[],
): string[] {
  const found: string[] = [];
  for (const [where, text] of surfaces) {
    for (const needle of needles) {
      if (text.includes(needle)) found.push(`${where}: ${needle}`);
    }
  }
  return found;
}

export const needlesOf = (s: Seeded) => [
  ...Object.values(S),
  ...s.hide,
  // A folder emptied by the hide leaves with it; its id is as telling as its name.
  ...s.hidden.flatMap((item) => (item.folderId ? [item.folderId] : [])),
];
