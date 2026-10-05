/** Accounts for tests: a plain password, one with a pepper slot, a derived one, an older sealed one (ADR 0172-0174). */

import {
  type AccountItem,
  DEFAULT_RULES,
  type PasswordMethod,
  completePassword,
  createItem,
  manualPassword,
  mintRootSecret,
  pepperBinding,
  produceAccountPassword,
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

/**
 * A stored password with *Include pepper* on: the account keeps the password
 * and where the pepper goes, and never a pepper (ADR 0174).
 */
export function pepperedAccount(
  name: string,
  password: string,
  pepperAt?: string,
): AccountItem {
  const item = createItem("account", name);
  item.methods = [
    {
      ...manualPassword(`${item.id}:password`, password, item.createdAt),
      pepper: true,
      ...(pepperAt === undefined ? undefined : { pepperAt }),
    },
  ];
  return item;
}

/** What an older version made: a password sealed under a pepper the person typed (v1). */
export async function legacySealedAccount(
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

/** A derived password with *Include pepper* on, the pepper going at `pepperAt`. */
export function pepperedDerivedAccount(
  name: string,
  pepperAt?: string,
): AccountItem {
  const item = derivedAccount(name);
  const [method] = item.methods;
  if (method?.type !== "password") throw new Error("fixture");
  item.methods = [
    {
      ...method,
      pepper: true,
      ...(pepperAt === undefined ? undefined : { pepperAt }),
    },
  ];
  return item;
}

/** Type a password into a method, which makes it a manual one: a new account's is derived. */
export function typePassword(method: PasswordMethod, password: string): void {
  method.generator = { id: "manual" };
  method.secret = password;
}

/** The whole password an account produces with nothing from the person, else `""`. */
export function producedPassword(item: AccountItem): string {
  return completePassword(produceAccountPassword(item)) ?? "";
}
