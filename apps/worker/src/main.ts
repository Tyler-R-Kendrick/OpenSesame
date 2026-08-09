import {
  createDrizzle,
  createPostgresOidcStore,
  createRepositories,
} from "@opensesame/database";
import { createLogger } from "@opensesame/observability";
import { startCleanupLoop } from "./cleanup.js";

/**
 * Identity-plane cleanup worker (TS). Coexists with the Rust authority worker
 * binary in this directory (`opensesame-worker`).
 */
async function main(): Promise<void> {
  const log = createLogger({ name: "worker" });
  const databaseUrl = process.env.DATABASE_URL?.trim();
  // Without a database `createRepositories` returns in-memory repositories. In the
  // control plane that is a usable dev mode, because the process that writes the
  // outbox is the one reading it. A separate worker process reading its own empty
  // map does nothing at all, forever, while logging healthy ticks — so it refuses
  // to start rather than impersonate a working one.
  if (!databaseUrl) {
    log.error(
      "DATABASE_URL is required: a standalone cleanup worker without a database would publish an outbox nobody writes to",
    );
    process.exit(1);
  }
  const repos = createRepositories({ databaseUrl });
  const { db } = createDrizzle(databaseUrl);
  const oidcStore = createPostgresOidcStore(db);
  const intervalMs = Number(
    process.env.OPENSESAME_WORKER_INTERVAL_MS ?? "5000",
  );
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  process.on("SIGTERM", () => ac.abort());

  // Claims, provisional sessions and temporary projects live in the control
  // plane's process. This worker cannot see them, and it used to be handed empty
  // maps — reporting successful ticks while expiring nothing, which reads as TTL
  // enforcement that is not happening. It publishes the outbox, prunes the
  // issuer's expired rows, and says so.
  log.warn(
    { intervalMs },
    "standalone cleanup worker: outbox and issuer row pruning — claim, session and project expiry run in-process in the control plane",
  );
  await startCleanupLoop({
    repos,
    oidcStore,
    clock: () => new Date(),
    log,
    intervalMs,
    signal: ac.signal,
  });
  log.info("worker stopped");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
