/**
 * Postgres execution-reservation repository (ADR 0086).
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as coreSchema from "../schema/index.js";
import type { UnitOfWork } from "./interfaces.js";
import { createReservationAcquire } from "./wallet-interaction-postgres-reservation-acquire.js";
import { createReservationReaders } from "./wallet-interaction-postgres-reservation-readers.js";
import { createReservationWriters } from "./wallet-interaction-postgres-reservation-writers.js";
import type { ExecutionReservationRepository } from "./wallet-interaction-types.js";

type Database = PostgresJsDatabase<typeof coreSchema>;
type ResolveDb = (uow?: UnitOfWork) => Database;

export function createPostgresExecutionReservations(
  db: Database,
  resolveDb: ResolveDb,
): ExecutionReservationRepository {
  return {
    ...createReservationReaders(db),
    ...createReservationAcquire(db, resolveDb),
    ...createReservationWriters(db, resolveDb),
  };
}
