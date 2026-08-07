import { ClaimEngine, MemoryClaimStore } from "@opensesame/claims";
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
  // Standalone mode: empty claim store unless shared via process integration.
  // In-process tests inject IndexedClaimStore + ClaimEngine directly.
  const claimStore = Object.assign(new MemoryClaimStore(), {
    listIds(): string[] {
      return [];
    },
  });
  const claims = new ClaimEngine({
    pepper: process.env.OPENSESAME_CLAIM_PEPPER ?? "dev-claim-pepper-change-me",
    store: claimStore,
  });

  const intervalMs = Number(process.env.OPENSESAME_WORKER_INTERVAL_MS ?? "5000");
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  process.on("SIGTERM", () => ac.abort());

  log.info({ intervalMs }, "identity cleanup worker starting");
  await startCleanupLoop({
    claims,
    claimStore,
    repos,
    provisionalSessions: new Map(),
    projects: new Map(),
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
