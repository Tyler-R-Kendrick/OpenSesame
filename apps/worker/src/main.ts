import { createRepositories } from "@opensesame/database";
import { createLogger } from "@opensesame/observability";
import { startCleanupLoop } from "./cleanup.js";

/**
 * Identity-plane cleanup worker (TS). Coexists with the Rust authority worker
 * binary in this directory (`opensesame-worker`).
 */
async function main(): Promise<void> {
  const log = createLogger({ name: "worker" });
  const repos = createRepositories();
  const intervalMs = Number(
    process.env.OPENSESAME_WORKER_INTERVAL_MS ?? "5000",
  );
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  process.on("SIGTERM", () => ac.abort());

  // Claims, provisional sessions and temporary projects live in the control
  // plane's process. This worker cannot see them, and it used to be handed empty
  // maps — reporting successful ticks while expiring nothing, which reads as TTL
  // enforcement that is not happening. It publishes the outbox and says so.
  log.warn(
    { intervalMs },
    "standalone cleanup worker: outbox only — claim, session and project expiry run in-process in the control plane",
  );
  await startCleanupLoop({
    repos,
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
