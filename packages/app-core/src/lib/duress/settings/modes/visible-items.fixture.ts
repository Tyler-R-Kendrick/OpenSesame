/** What the visible-items tests are made of: a few real items, one dressed in everything a copy must leave behind. */
import {
  type LoginItem,
  type VaultItem,
  createItem,
} from "@opensesame/vault-core";

export const HIDDEN = "hidden-distinct-password-91Qz";

export function login(name: string, over: Partial<LoginItem> = {}): LoginItem {
  return {
    ...createItem("login", name),
    username: `${name.toLowerCase()}@example.test`,
    password: `pw-${name}`,
    notes: `notes of ${name}`,
    ...over,
  };
}

/** A login dressed with everything a copy must leave behind. */
export function dressed(): LoginItem {
  const item = login("Bank", {
    totp: "JBSWY3DPEXAMPLESEED",
    folderId: "folder-secret-id",
    resetEmailId: "reset-mail-id",
    supersededById: "superseded-id",
    reenrollState: "old-retired",
    favorite: true,
    uris: [{ id: "u1", uri: "https://bank.example.test", match: "host" }],
    fields: [{ id: "f1", name: "PIN", value: "4321", hidden: true }],
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
  login("Netflix"),
  login("Hidden Bank", { password: HIDDEN }),
  createItem("note", "Gym code"),
  secret("Wi-Fi"),
  createItem("card", "Visa"),
];

export const ctx = (list: VaultItem[]) => ({ items: list });
export const extrasFor = (list: VaultItem[]) => ({
  shown: list.map((item) => item.id).join("\n"),
});
