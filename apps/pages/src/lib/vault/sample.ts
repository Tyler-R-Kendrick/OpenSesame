/**
 * Opt-in demonstration items. Never seeded automatically: the user asks for these
 * from Settings, every one carries `sample: true`, the UI badges them, and a single
 * action removes them all.
 */

import {
  type Folder,
  type VaultItem,
  createItem,
  newGrant,
  newUri,
} from "./model.js";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export const SAMPLE_FOLDER_NAME = "Sample data";

export function buildSample(folderId: string): VaultItem[] {
  const items: VaultItem[] = [];

  const bank = createItem("login", "Northwind Bank");
  bank.username = "avery@example.com";
  bank.password = "Fjord-Lantern-Cobalt-7"; // gitleaks:allow -- sample vault
  bank.totp = "JBSWY3DPEHPK3PXP";
  bank.uris = [newUri("https://northwind.example.com")];
  bank.passwordChangedAt = daysAgo(40);
  bank.favorite = true;
  items.push(bank);

  const forum = createItem("login", "Old forum account");
  forum.username = "avery";
  forum.password = "summer2019";
  forum.uris = [newUri("https://forum.example.org")];
  forum.passwordChangedAt = daysAgo(1_400);
  forum.notes =
    "Kept only for the archive. Flagged by the health report on purpose.";
  items.push(forum);

  const shop = createItem("login", "Parts supplier");
  shop.username = "avery@example.com";
  shop.password = "summer2019";
  shop.uris = [newUri("https://parts.example.net", "host")];
  shop.passwordChangedAt = daysAgo(600);
  shop.notes = "Shares a password with the forum account — that is the point.";
  items.push(shop);

  const passkey = createItem("passkey", "Northwind Bank passkey");
  passkey.rpId = "northwind.example.com";
  passkey.username = "avery@example.com";
  passkey.authenticator = "platform";
  passkey.notes =
    "Record of a credential held by this device's authenticator. The private key never enters the vault.";
  items.push(passkey);

  const card = createItem("card", "Travel card");
  card.cardholder = "A. Rowan";
  card.brand = "Visa";
  card.number = "4111111111111111";
  card.expMonth = "04";
  card.expYear = "2029";
  card.code = "123";
  items.push(card);

  const secret = createItem("secret", "Deploy webhook");
  secret.value = "whsec_3f7a1c9d4b8e2a6f0c5d1e9b7a3f2c8d"; // gitleaks:allow -- sample vault
  secret.connectionRef = "conn_deploy_webhook";
  secret.grantees = ["agt_release_bot"];
  secret.ceiling = [
    newGrant("http.post", "https://deploy.example.com/hooks/release"),
    newGrant("http.get", "https://deploy.example.com/status"),
  ];
  secret.notes =
    "The release agent may invoke these two calls through the Host plane. It cannot read this value.";
  items.push(secret);

  const note = createItem("note", "Recovery kit location");
  note.notes =
    "Paper recovery kit is in the fire safe. The master password is not written down anywhere, including here.";
  items.push(note);

  return items.map((item) => ({ ...item, folderId, sample: true }));
}

export function sampleFolder(): Folder {
  return {
    id: crypto.randomUUID(),
    name: SAMPLE_FOLDER_NAME,
    createdAt: new Date().toISOString(),
  };
}
