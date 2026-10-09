import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schemaNs from "../schema/index.js";
import type { UnitOfWork } from "./interfaces.js";

type Db = PostgresJsDatabase<typeof schemaNs>;

function applyNowOrDefer(uow: UnitOfWork | undefined, apply: () => void): void {
  if (uow?.defer) {
    uow.defer(apply);
    return;
  }
  apply();
}

export type ProviderReplayConsumer = {
  consumeProviderAssertionReplay: (
    issuer: string,
    jti: string,
    expiresAt: Date,
    uow?: UnitOfWork,
  ) => Promise<boolean>;
};

export function createMemoryProviderReplayConsumer(): ProviderReplayConsumer {
  const providerReplays = new Map<string, { expiresAt: Date }>();
  return {
    async consumeProviderAssertionReplay(issuer, jti, expiresAt, uow) {
      const key = `${issuer}\0${jti}`;
      const existing = providerReplays.get(key);
      if (existing && existing.expiresAt.getTime() > Date.now()) return false;
      applyNowOrDefer(uow, () => {
        providerReplays.set(key, { expiresAt });
      });
      return true;
    },
  };
}

export function postgresConsumeProviderAssertionReplay(
  resolveDb: (uow?: UnitOfWork) => Db,
  schema: typeof schemaNs,
  issuer: string,
  jti: string,
  expiresAt: Date,
  uow?: UnitOfWork,
): Promise<boolean> {
  const conn = resolveDb(uow);
  return conn
    .insert(schema.agentProviderAssertionReplays)
    .values({ issuer, jti, expiresAt })
    .onConflictDoNothing()
    .returning({ jti: schema.agentProviderAssertionReplays.jti })
    .then((inserted) => inserted.length === 1);
}
