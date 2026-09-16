/**
 * Postgres wallet-registration repository (ADR 0086).
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as coreSchema from "../schema/index.js";
import type { UnitOfWork } from "./interfaces.js";
import { createWalletRegistrationReaders } from "./wallet-interaction-postgres-registration-readers.js";
import { createWalletRegistrationRegister } from "./wallet-interaction-postgres-registration-register.js";
import { createWalletRegistrationUpdates } from "./wallet-interaction-postgres-registration-updates.js";
import type { WalletRegistrationRepository } from "./wallet-interaction-types.js";

type Database = PostgresJsDatabase<typeof coreSchema>;
type ResolveDb = (uow?: UnitOfWork) => Database;

export function createPostgresWalletRegistrations(
  db: Database,
  resolveDb: ResolveDb,
): WalletRegistrationRepository {
  return {
    ...createWalletRegistrationReaders(db),
    ...createWalletRegistrationRegister(db, resolveDb),
    ...createWalletRegistrationUpdates(db, resolveDb),
  };
}
