import { isString, overlapCast } from "@opensesame/os-domain";
import type { Account, Session, User } from "better-auth";
import type { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { AccountSecretCodec } from "./account-secret-adapter.js";

type Adapter = Omit<
  ReturnType<ReturnType<typeof drizzleAdapter>>,
  "transaction"
>;
type Row = Partial<Account & Session & User> & {
  account?: Account[];
  session?: (Session & { sealedToken?: string })[];
  sealedToken?: string;
};
type Where = Parameters<Adapter["findOne"]>[0]["where"];
const LOOKUP_PURPOSE = "better_auth_sessions.token";

function lookupWhere(
  model: string,
  where: Where | undefined,
  codec: AccountSecretCodec,
): Where | undefined {
  if (model !== "session" || !where) return where;
  return where.map((filter) => {
    if (filter.field !== "token") return filter;
    if (
      filter.operator &&
      !["eq", "ne", "in", "not_in"].includes(filter.operator)
    )
      throw new Error("Session token lookup requires equality");
    const convert = (value: string | number | boolean | Date | null) => {
      if (!isString(value))
        throw new Error("Session token lookup requires a string");
      return codec.lookup(LOOKUP_PURPOSE, value);
    };
    return {
      ...filter,
      value: Array.isArray(filter.value)
        ? filter.value.map(convert)
        : convert(filter.value),
    };
  });
}

function sealSession(row: Row, codec: AccountSecretCodec): Row {
  if (!isString(row.token) || !isString(row.userId))
    throw new Error("Session encryption requires a token and owner");
  const digest = codec.lookup(LOOKUP_PURPOSE, row.token);
  return {
    ...row,
    token: digest,
    sealedToken: codec.seal(
      JSON.stringify(["better_auth_sessions", digest, "token"]),
      row.userId,
      row.token,
    ),
  };
}

function openSession(
  model: string,
  row: Row | null,
  codec: AccountSecretCodec,
): Row | null {
  if (!row) return null;
  const { sealedToken: _sealedToken, ...result } = row;
  if (model === "session") {
    if (
      !isString(row.token) ||
      !isString(row.userId) ||
      !isString(row.sealedToken)
    )
      throw new Error("Durable session credential is not encrypted");
    result.token = codec.open(
      JSON.stringify(["better_auth_sessions", row.token, "token"]),
      row.userId,
      row.sealedToken,
    );
  } else if (Array.isArray(result.session)) {
    result.session = overlapCast(
      result.session.map((session) => openSession("session", session, codec)),
    );
  }
  return result;
}

function project(row: Row | null, select?: string[]): Row | null {
  return row && select
    ? Object.fromEntries(
        select.map((field) => [
          field,
          row[overlapCast<string, keyof Row>(field)],
        ]),
      )
    : row;
}

function sessionReads(
  adapter: Adapter,
  codec: AccountSecretCodec,
): Pick<Adapter, "findOne" | "findMany" | "count"> {
  return {
    async findOne(input) {
      const row = await adapter.findOne<Row>({
        ...input,
        where: lookupWhere(input.model, input.where, codec) ?? [],
        select: input.model === "session" ? undefined : input.select,
      });
      return overlapCast(
        project(
          openSession(input.model, row, codec),
          input.model === "session" ? input.select : undefined,
        ),
      );
    },
    async findMany(input) {
      const rows = await adapter.findMany<Row>({
        ...input,
        where: lookupWhere(input.model, input.where, codec),
        select: input.model === "session" ? undefined : input.select,
      });
      return overlapCast(
        rows.map((row) =>
          project(
            openSession(input.model, row, codec),
            input.model === "session" ? input.select : undefined,
          ),
        ),
      );
    },
    async count(input) {
      return adapter.count({
        ...input,
        where: lookupWhere(input.model, input.where, codec),
      });
    },
  };
}

function validateUpdate(update: Row): void {
  if (["token", "userId", "sealedToken"].some((field) => field in update))
    throw new Error("Encrypted session identity is immutable");
}

function sessionWrites(
  adapter: Adapter,
  codec: AccountSecretCodec,
): Pick<Adapter, "create" | "update" | "updateMany" | "incrementOne"> {
  return {
    async create(input) {
      const row = overlapCast<typeof input.data, Row>(input.data);
      if (input.model === "session" && "sealedToken" in row)
        throw new Error("Session envelope is internal");
      const created = await adapter.create<Row>({
        ...input,
        data: input.model === "session" ? sealSession(row, codec) : row,
        select: input.model === "session" ? undefined : input.select,
      });
      return overlapCast(
        project(openSession(input.model, created, codec), input.select),
      );
    },
    async update(input) {
      if (input.model === "session") validateUpdate(input.update);
      const row = await adapter.update<Row>({
        ...input,
        where: lookupWhere(input.model, input.where, codec) ?? [],
      });
      return overlapCast(openSession(input.model, row, codec));
    },
    async updateMany(input) {
      if (input.model === "session") validateUpdate(input.update);
      return adapter.updateMany({
        ...input,
        where: lookupWhere(input.model, input.where, codec) ?? [],
      });
    },
    async incrementOne(input) {
      if (input.model === "session") {
        validateUpdate(input.increment);
        validateUpdate(input.set ?? {});
      }
      const row = await adapter.incrementOne<Row>({
        ...input,
        where: lookupWhere(input.model, input.where, codec) ?? [],
      });
      return overlapCast(openSession(input.model, row, codec));
    },
  };
}

function sessionDeletes(
  adapter: Adapter,
  codec: AccountSecretCodec,
): Pick<Adapter, "delete" | "deleteMany" | "consumeOne"> {
  return {
    delete: (input) =>
      adapter.delete({
        ...input,
        where: lookupWhere(input.model, input.where, codec) ?? [],
      }),
    deleteMany: (input) =>
      adapter.deleteMany({
        ...input,
        where: lookupWhere(input.model, input.where, codec) ?? [],
      }),
    async consumeOne(input) {
      const row = await adapter.consumeOne<Row>({
        ...input,
        where: lookupWhere(input.model, input.where, codec) ?? [],
      });
      return overlapCast(openSession(input.model, row, codec));
    },
  };
}

/** The indexed token column is a keyed lookup digest, never a usable bearer. */
export function withSessionSecrets(
  adapter: Adapter,
  codec: AccountSecretCodec,
): Adapter {
  return {
    ...adapter,
    ...sessionReads(adapter, codec),
    ...sessionWrites(adapter, codec),
    ...sessionDeletes(adapter, codec),
  };
}
