import { isString, overlapCast } from "@opensesame/os-domain";
import type { Account, Session, User } from "better-auth";
import type { drizzleAdapter } from "better-auth/adapters/drizzle";
import { withSessionSecrets } from "./session-secret-adapter.js";

type Adapter = ReturnType<ReturnType<typeof drizzleAdapter>>;
type TransactionAdapter = Omit<Adapter, "transaction">;
type Row = Partial<Account & Session & User> & {
  account?: Account[];
  session?: (Session & { sealedToken?: string })[];
  sealedToken?: string;
};
const secretFields = [
  "accessToken",
  "refreshToken",
  "idToken",
  "password",
] as const;

/** Supplied by the database owner; this package does not own encryption keys. */
export interface AccountSecretCodec {
  lookup(purpose: string, value: string): string;
  seal(purpose: string, owner: string, value: string): string;
  open(purpose: string, owner: string, value: string): string;
}

function transform(
  row: Row,
  codec: AccountSecretCodec,
  operation: "seal" | "open",
): Row {
  const result = { ...row };
  for (const field of secretFields) {
    const value = row[overlapCast<string, keyof Row>(field)];
    if (!isString(value)) continue;
    if (
      !isString(row.userId) ||
      !isString(row.accountId) ||
      !isString(row.providerId)
    ) {
      throw new Error(
        "Account secret encryption requires its owner and provider identity",
      );
    }
    const purpose = JSON.stringify([
      "better_auth_accounts",
      row.providerId,
      row.accountId,
      field,
    ]);
    result[field] = codec[operation](purpose, row.userId, value);
  }
  return result;
}

function openAccount(
  codec: AccountSecretCodec,
  model: string,
  row: Row | null,
): Row | null {
  if (!row) return null;
  const result =
    model === "account" ? transform(row, codec, "open") : { ...row };
  // Better Auth may load accounts as a join on its user model.
  if (model !== "account" && Array.isArray(result.account)) {
    result.account = overlapCast(
      result.account.map((account) => openAccount(codec, "account", account)),
    );
  }
  return result;
}
const secretUpdate = (value: Row) =>
  secretFields.some((field) => isString(value[field]));
const checkIdentityUpdate = (value: Row) => {
  if (["userId", "accountId", "providerId"].some((field) => field in value)) {
    throw new Error("Encrypted account identity is immutable");
  }
};

function readAccountMethods(
  adapter: TransactionAdapter,
  codec: AccountSecretCodec,
): Pick<TransactionAdapter, "findOne" | "findMany"> {
  return {
    async findOne(input) {
      const row = await adapter.findOne<Row>({
        ...input,
        select: input.model === "account" ? undefined : input.select,
      });
      const opened = openAccount(codec, input.model, row);
      return overlapCast(
        opened && input.select && input.model === "account"
          ? Object.fromEntries(
              input.select.map((field) => [
                field,
                opened[overlapCast<string, keyof Row>(field)],
              ]),
            )
          : opened,
      );
    },
    async findMany(input) {
      const rows = await adapter.findMany<Row>({
        ...input,
        select: input.model === "account" ? undefined : input.select,
      });
      return overlapCast(
        rows.map((row) => {
          const opened = openAccount(codec, input.model, row);
          return opened && input.select && input.model === "account"
            ? Object.fromEntries(
                input.select.map((field) => [
                  field,
                  opened[overlapCast<string, keyof Row>(field)],
                ]),
              )
            : opened;
        }),
      );
    },
  };
}

function writeAccountMethods(
  adapter: TransactionAdapter,
  codec: AccountSecretCodec,
): Pick<TransactionAdapter, "update" | "updateMany"> {
  return {
    async update(input) {
      if (input.model !== "account") return adapter.update(input);
      checkIdentityUpdate(input.update);
      const current = await adapter.findOne<Row>({
        model: input.model,
        where: input.where,
      });
      if (!current) return null;
      const next = secretUpdate(input.update)
        ? transform({ ...current, ...input.update }, codec, "seal")
        : input.update;
      const update = Object.fromEntries(
        Object.keys(input.update).map((field) => [
          field,
          next[overlapCast<string, keyof Row>(field)],
        ]),
      );
      const row = await adapter.update<Row>({ ...input, update });
      return overlapCast(openAccount(codec, input.model, row));
    },
    async updateMany(input) {
      if (input.model !== "account") return adapter.updateMany(input);
      checkIdentityUpdate(input.update);
      if (!secretUpdate(input.update)) return adapter.updateMany(input);
      const rows = await adapter.findMany<Row>({
        model: input.model,
        where: input.where,
      });
      let count = 0;
      for (const row of rows) {
        const next = transform({ ...row, ...input.update }, codec, "seal");
        count += await adapter.updateMany({
          ...input,
          where: [...input.where, { field: "id", value: overlapCast(row.id) }],
          update: Object.fromEntries(
            Object.keys(input.update).map((field) => [
              field,
              next[overlapCast<string, keyof Row>(field)],
            ]),
          ),
        });
      }
      return count;
    },
  };
}

function lifecycleAccountMethods(
  adapter: TransactionAdapter,
  codec: AccountSecretCodec,
): Pick<TransactionAdapter, "create" | "consumeOne" | "incrementOne"> {
  return {
    async create(input) {
      const row = overlapCast<typeof input.data, Row>(input.data);
      const created = await adapter.create<Row>({
        ...input,
        data: input.model === "account" ? transform(row, codec, "seal") : row,
        select: input.model === "account" ? undefined : input.select,
      });
      const opened = openAccount(codec, input.model, created);
      return overlapCast(
        input.select
          ? Object.fromEntries(
              input.select.map((field) => [
                field,
                opened?.[overlapCast<string, keyof Row>(field)],
              ]),
            )
          : opened,
      );
    },
    async consumeOne(input) {
      return overlapCast(
        openAccount(codec, input.model, await adapter.consumeOne<Row>(input)),
      );
    },
    async incrementOne(input) {
      if (
        input.model === "account" &&
        input.set &&
        (secretUpdate(input.set) ||
          ["userId", "accountId", "providerId"].some(
            (field) => field in (input.set ?? {}),
          ))
      ) {
        throw new Error("Account credentials must be changed through update");
      }
      return overlapCast(
        openAccount(codec, input.model, await adapter.incrementOne<Row>(input)),
      );
    },
  };
}

/** Account credentials never reach the durable adapter in plaintext. */
export function withAccountSecrets(
  adapter: TransactionAdapter,
  codec: AccountSecretCodec,
): TransactionAdapter {
  return {
    ...adapter,
    ...readAccountMethods(adapter, codec),
    ...writeAccountMethods(adapter, codec),
    ...lifecycleAccountMethods(adapter, codec),
  };
}

export function sealedAccountAdapter(
  factory: ReturnType<typeof drizzleAdapter>,
  codec: AccountSecretCodec,
): ReturnType<typeof drizzleAdapter> {
  return (options) => {
    const adapter = factory(options);
    return {
      ...withSessionSecrets(withAccountSecrets(adapter, codec), codec),
      transaction: (callback) =>
        adapter.transaction((transaction) =>
          callback(
            withSessionSecrets(withAccountSecrets(transaction, codec), codec),
          ),
        ),
    };
  };
}
