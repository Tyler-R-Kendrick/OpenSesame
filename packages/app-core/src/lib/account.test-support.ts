/** Accounts for tests: a plain password, a peppered one, a derived one (ADR 0172, 0173). */

import {
  type AccountItem,
  DEFAULT_RULES,
  createItem,
  manualPassword,
  mintRootSecret,
  pepperBinding,
  sealWithPepper,
} from "@opensesame/vault-core";
import { sealWithOpaque } from "./vault/generators/opaque-seal.js";

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

/** A derived password: only `root` is stored, the password is computed from it. */
export function derivedAccount(
  name: string,
  counter = 0,
  root: string = mintRootSecret(),
): AccountItem {
  const item = createItem("account", name);
  item.methods = [
    {
      id: `${item.id}:password`,
      type: "password",
      generator: { id: "derived", rules: { ...DEFAULT_RULES }, counter },
      pepper: false,
      secret: root,
      changedAt: item.createdAt,
    },
  ];
  return item;
}

/** A derived password whose root is sealed under `pepper` (OPAQUE); `secret` stays empty. */
export async function pepperedDerivedAccount(
  name: string,
  pepper: string,
): Promise<AccountItem> {
  const item = derivedAccount(name);
  const [method] = item.methods;
  if (method?.type !== "password") throw new Error("fixture");
  item.methods = [
    {
      ...method,
      pepper: true,
      secret: "",
      sealed: await sealWithOpaque(
        method.secret,
        pepper,
        pepperBinding(item.id, method.id),
      ),
    },
  ];
  return item;
}
