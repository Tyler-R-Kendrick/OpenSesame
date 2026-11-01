import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

/** Pin matches ADR 0010 integration posture; refresh only with an explicit review. */
export const PINNED_POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:1072410c3c262da7555399249b269271667d24a9089573a917b3497dd251373f";

export type EphemeralPostgres = {
  databaseUrl: string;
  stop: () => Promise<void>;
};

/**
 * Starts a disposable Postgres for integration tests when Docker is available.
 * Callers should skip the suite when this throws (for example in sandboxes
 * without a Docker socket).
 */
export async function startEphemeralPostgres(): Promise<EphemeralPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    PINNED_POSTGRES_IMAGE,
  ).start();
  return {
    databaseUrl: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}
