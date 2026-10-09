/**
 * Postgres wallet-adjacent interaction repositories (ADR 0086).
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as coreSchema from "../schema/index.js";
import type { UnitOfWork } from "./interfaces.js";
import { createPostgresProofAttempts } from "./wallet-interaction-postgres-proofs.js";
import { createPostgresWalletRegistrations } from "./wallet-interaction-postgres-registrations.js";
import { createPostgresExecutionReservations } from "./wallet-interaction-postgres-reservations.js";
import type {
  ExecutionReservationRepository,
  InteractionProofAttemptRepository,
  WalletRegistrationRepository,
} from "./wallet-interaction-types.js";

type Database = PostgresJsDatabase<typeof coreSchema>;
type ResolveDb = (uow?: UnitOfWork) => Database;

export function createPostgresWalletInteractionRepos(
  db: Database,
  resolveDb: ResolveDb,
): {
  interactionProofAttempts: InteractionProofAttemptRepository;
  walletRegistrations: WalletRegistrationRepository;
  executionReservations: ExecutionReservationRepository;
} {
  return {
    interactionProofAttempts: createPostgresProofAttempts(db, resolveDb),
    walletRegistrations: createPostgresWalletRegistrations(db, resolveDb),
    executionReservations: createPostgresExecutionReservations(db, resolveDb),
  };
}
