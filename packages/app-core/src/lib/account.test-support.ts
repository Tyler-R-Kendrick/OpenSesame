/** Accounts for tests: a plain password, a peppered one, a Sphinx one (ADR 0168). */

import {
  type AccountItem,
  createItem,
  manualPassword,
  pepperBinding,
  sealWithPepper,
} from "@opensesame/vault-core";

type PlainAccountExtras = { username?: string; totp?: string };

export function plainAccount(
  name: string,
  password: string,
  extra: PlainAccountExtras = {},
): AccountItem {
  const item = createItem("account", name);
  item.username = extra.username ?? "";
  item.methods = [
    manualPassword(`${item.id}:password`, password, item.createdAt),
  ];
  if (extra.totp !== undefined && extra.totp !== "") {
    item.methods.push({
      id: `${item.id}:authenticator`,
      type: "authenticator",
      secret: extra.totp,
    });
  }
  return item;
}

/** A manual password sealed under `pepper`; `secret` stays empty. */
export async function pepperedAccount(
  name: string,
  password: string,
  pepper: string,
): Promise<AccountItem> {
  const item = createItem("account", name);
  const id = `${item.id}:password`;
  item.methods = [
    {
      id,
      type: "password",
      generator: { id: "manual" },
      pepper: true,
      secret: "",
      sealed: await sealWithPepper(
        password,
        pepper,
        pepperBinding(item.id, id),
      ),
      changedAt: item.createdAt,
    },
  ];
  return item;
}
