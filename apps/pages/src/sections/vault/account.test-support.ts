/**
 * Account records for suites that need one with a known password. Test
 * support: never imported by the app.
 */
import {
  type AccountItem,
  type LoginMethod,
  createItem,
  manualPassword,
} from "@opensesame/vault-core";

/** `account` with its methods set to one manual, unpeppered password. */
export function withPassword<T extends AccountItem>(
  account: T,
  password: string,
): T {
  account.methods = [
    manualPassword(`${account.id}:password`, password, account.createdAt),
  ];
  return account;
}

export type AccountSeed = Partial<Omit<AccountItem, "methods">> & {
  methods?: LoginMethod[];
  /** Shorthand for a manual password method; `""` leaves the account without one. */
  password?: string;
  /** Shorthand for an authenticator method; `""` for none. */
  totp?: string;
  passwordChangedAt?: string;
};

/** A complete account with every field the model requires and shorthands for its methods. */
export function makeAccount(seed: AccountSeed = {}): AccountItem {
  const { password, totp, passwordChangedAt, methods, ...rest } = seed;
  const id = rest.id ?? "itm_1";
  const created = rest.createdAt ?? "2026-08-01T00:00:00Z";
  const built: LoginMethod[] = methods ?? [];
  if (methods === undefined) {
    if (password !== "")
      built.push(
        manualPassword(
          `${id}:password`,
          password ?? "hunter2hunter2hunter2",
          passwordChangedAt ?? "2026-08-01T00:00:00Z",
        ),
      );
    if (totp)
      built.push({ id: `${id}:authenticator`, type: "authenticator", secret: totp });
  }
  return {
    ...createItem("account", "Webmail"),
    id,
    createdAt: created,
    updatedAt: "2026-08-02T00:00:00Z",
    username: "me@example.com",
    uris: [],
    ...rest,
    methods: built,
  };
}
