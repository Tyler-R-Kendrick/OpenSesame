/**
 * What the visible-items end-to-end tests are made of: a real personal vault
 * seeded with the items the walk is about, the arming call, and a scan that
 * says which strings appear in clear in anything the device stores.
 */

import {
  type AccountItem,
  type VaultItem,
  createItem,
} from "@opensesame/vault-core";
import { duressContinueSeams } from "../../../screens/unlock/unlock-duress-continue.js";
import { unlockWithPasswordAfterDuressGate } from "../../../screens/unlock/unlock-password-duress.js";
import { plainAccount } from "../../account.test-support.js";
import { kvGet } from "../../kv.js";
import { LAST_VAULT_KEY } from "../../last-vault.js";
import { ATTEMPTS_KEY, VaultStore } from "../../vault/store.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../../vfs.js";
import { duressSessionFence } from "../session/fence.js";
import { enableDuressCode } from "../settings/device-duress.js";
import {
  DURESS_BOOT_KEYS,
  ENROLLMENT_STATE_KEY,
  journalKeysOf,
} from "../store/boot-keys.js";
import { DECOY_SCRATCH_TOMB } from "../store/decoy-scratch.js";

export const shipped = duressContinueSeams.runEffects;

export const PASSWORD = "correct horse battery staple";
export const CODE = "739104628";
export const tombs = [GUEST_TOMB, PERSONAL_TOMB, DECOY_SCRATCH_TOMB];
export const TOMB_PATHS = [
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  "config/device-identity-key",
];

/** Distinct strings, so a leak is a substring and never a coincidence. */
export const HIDDEN = {
  name: "Hidden Bank 7731",
  username: "hidden.user.7731@example.test",
  password: "hidden-pw-Zq91-xk", // gitleaks:allow — validated synthetic fixture or fixed non-secret identifier
  notes: "hidden notes 7731 about the safe",
  uri: "https://hidden-bank-7731.example.test",
} as const;
export const HIDDEN_NOTE = {
  name: "Hidden Locker 5520",
  notes: "combination 5520-A",
};
export const PASSKEY_NAME = "Passkey 3318";
export const TRASHED = {
  name: "Trashed Mail 9042",
  password: "trashed-pw-9042", // gitleaks:allow — validated synthetic fixture or fixed non-secret identifier
};
export const SEED = "JBSWY3DPEXAMPLESEED";

export function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) duressSessionFence.resolve(ids, true);
}

export type Seeded = {
  store: VaultStore;
  netflix: AccountItem;
  authy: AccountItem;
  passkey: VaultItem;
  trashed: AccountItem;
  all: VaultItem[];
};

/** A real personal vault with the items the test is about, left OPEN. */
export async function openVault(): Promise<Seeded> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  const netflix: AccountItem = {
    ...plainAccount("Netflix", "netflix-pw-4417", {
      username: "me@example.test",
    }),
    notes: "family plan",
    favorite: true,
    uris: [{ id: "uri-1", uri: "https://netflix.example.test", match: "host" }],
    fields: [{ id: "f-1", name: "Profile", value: "Kids", hidden: false }],
    folderId: "folder-real-1",
  };
  const authy = plainAccount("Mail with 2FA", "mail-pw-6612", {
    username: "mail@example.test",
    totp: SEED,
  });
  const hidden: AccountItem = {
    ...plainAccount(HIDDEN.name, HIDDEN.password, {
      username: HIDDEN.username,
    }),
    notes: HIDDEN.notes,
    uris: [{ id: "uri-h", uri: HIDDEN.uri, match: "host" }],
  };
  const hiddenNote = {
    ...createItem("note", HIDDEN_NOTE.name),
    notes: HIDDEN_NOTE.notes,
  };
  const passkey = createItem("passkey", PASSKEY_NAME);
  const trashed = plainAccount(TRASHED.name, TRASHED.password);
  for (const item of [netflix, authy, hidden, hiddenNote, passkey, trashed]) {
    await store.saveItem(item);
  }
  await store.trashItem(trashed.id);
  await store.flushPendingWrites();
  return {
    store,
    netflix,
    authy,
    passkey,
    trashed,
    all: store.getSnapshot().items,
  };
}

export async function arm(
  seeded: Seeded,
  ids: readonly string[],
  items: readonly VaultItem[] = seeded.store.getSnapshot().items,
) {
  return enableDuressCode({
    code: CODE,
    mode: "visible_items",
    extras: { shown: ids.join("\n") },
    items,
    vaultRef: "vault-1",
    requireDurable: false,
  });
}

/** Lock the vault, the way a person hands over a locked device. */
export async function lockIt(store: VaultStore): Promise<void> {
  store.lock();
  await vfsFlush();
  store.loadActiveProjectScope();
}

export const typeCode = (store: VaultStore) =>
  unlockWithPasswordAfterDuressGate(store, CODE, { requireDurable: false });

/** Every key this device keeps the duress state, the vault and the decoy under. */
export function storedKeys(): string[] {
  return [
    ...tombs.flatMap((tomb) =>
      TOMB_PATHS.map((path) => tombFileKey(tomb, path)),
    ),
    ...DURESS_BOOT_KEYS,
    ...journalKeysOf(ENROLLMENT_STATE_KEY),
    ATTEMPTS_KEY,
    LAST_VAULT_KEY,
  ];
}

/** Which of `needles` appear in clear in anything the device has stored. */
export function leaksIn(values: readonly string[], needles: readonly string[]) {
  return needles.filter((needle) => values.some((v) => v.includes(needle)));
}

export const everythingStored = () =>
  storedKeys().flatMap((key) => {
    const value = kvGet(key);
    return value === null ? [] : [value];
  });

export const hiddenStrings: string[] = [
  ...Object.values(HIDDEN),
  HIDDEN_NOTE.name,
  HIDDEN_NOTE.notes,
  PASSKEY_NAME,
  TRASHED.name,
  TRASHED.password,
  SEED,
  "folder-real-1",
];
