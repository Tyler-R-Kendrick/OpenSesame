/**
 * Where the Identity plane seals its event rows (ADR 0157).
 *
 * The audit trail, the outbox and the delivery queues rest sealed in Postgres.
 * The key is derived from `OPENSESAME_EVENT_KEY`, else from the claim pepper
 * the deployment already requires. A database that would outlive its process
 * with neither set refuses to start: a process-local pepper would seal events
 * that nothing could open after a restart.
 */

import {
  type Database,
  type EventSealer,
  PostgresRepositories,
  type Repositories,
  createEventSealer,
  eventSealSecret,
  sealLegacyEvents,
  sealLegacySecrets,
  withSealedEvents,
  withSealedSecrets,
} from "@opensesame/database";

export function resolveEventSealer(
  env: NodeJS.ProcessEnv,
  claimPepper: string,
  persistentDatabase: boolean,
): EventSealer {
  const configured = eventSealSecret({
    OPENSESAME_EVENT_KEY: env.OPENSESAME_EVENT_KEY,
    OPENSESAME_CLAIM_PEPPER: env.OPENSESAME_CLAIM_PEPPER,
  });
  if (env.OPENSESAME_EVENT_KEY && env.OPENSESAME_EVENT_KEY.length < 32) {
    throw new Error("OPENSESAME_EVENT_KEY must contain at least 32 characters");
  }
  if (configured !== undefined) return createEventSealer(configured);
  if (persistentDatabase) {
    throw new Error(
      "OPENSESAME_EVENT_KEY or OPENSESAME_CLAIM_PEPPER must be set when a database is configured: audit, outbox and delivery payloads are sealed at rest",
    );
  }
  return createEventSealer(claimPepper);
}

/** Postgres repositories seal their event rows; memory repositories hold nothing at rest. */
export function sealPostgresEvents(
  repos: Repositories,
  sealer: EventSealer,
): Repositories {
  return repos instanceof PostgresRepositories
    ? withSealedEvents(withSealedSecrets(repos, sealer), sealer)
    : repos;
}

/** Validate durable envelopes; import legacy rows only with explicit operator opt-in. */
export async function sealExistingEvents(
  db: Database,
  sealer: EventSealer,
  allowLegacy = false,
): Promise<void> {
  await sealLegacyEvents(db, sealer, allowLegacy);
  await sealLegacySecrets(db, sealer, allowLegacy);
}
