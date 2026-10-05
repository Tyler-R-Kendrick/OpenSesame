/** What the visible-items tests are made of: a few real items, one dressed in everything a copy must leave behind. */
import {
  type AccountItem,
  type VaultItem,
  createItem,
  passwordMethod,
} from "@opensesame/vault-core";
import { plainAccount } from "../../../account.test-support.js";

export const HIDDEN = "hidden-distinct-password-91Qz";

type AccountOver = Partial<AccountItem> & {
  password?: string;
  totp?: string;
  passwordChangedAt?: string;
};

export function account(name: string, over: AccountOver = {}): AccountItem {
  const { password = `pw-${name}`, totp, passwordChangedAt, ...rest } = over;
  const item = plainAccount(name, password, {
    username: `${name.toLowerCase()}@example.test`,
    ...(totp === undefined ? {} : { totp }),
  });
  const method = passwordMethod(item);
  if (method && passwordChangedAt !== undefined) {
    method.changedAt = passwordChangedAt;
  }
  return { ...item, notes: `notes of ${name}`, ...rest };
}

/** An account dressed with everything a copy must leave behind. */
export function dressed(): AccountItem {
  const item = account("Bank", {
    totp: "JBSWY3DPEXAMPLESEED",
    folderId: "folder-secret-id",
    resetEmailId: "reset-mail-id",
    supersededById: "superseded-id",
    reenrollState: "old-retired",
    favorite: true,
    uris: [{ id: "u1", uri: "https://bank.example.test", match: "host" }],
    fields: [
      { id: "f1", name: "PIN", value: "4321", hidden: true },
      { id: "f2", name: "Branch", value: "Downtown", hidden: false },
    ],
  });
  // What the model does not name must not travel either.
  const extra: Record<string, unknown> = item;
  extra.history = [{ password: "old-history-password" }];
  extra.attachments = [{ name: "scan.pdf", key: "file-part-key" }];
  return item;
}

export const secret = (name: string): VaultItem => ({
  ...createItem("secret", name),
  value: "s-value",
  ceiling: [{ id: "g1", action: "read", resource: "x" }],
  grantees: ["agent-7"],
  connectionRef: "conn-9",
});

export const items = (): VaultItem[] => [
  account("Netflix"),
  account("Hidden Bank", { password: HIDDEN }),
  createItem("note", "Gym code"),
  secret("Wi-Fi"),
  createItem("card", "Visa"),
];

export const ctx = (list: VaultItem[]) => ({ items: list });
export const extrasFor = (list: VaultItem[]) => ({
  shown: list.map((item) => item.id).join("\n"),
});
