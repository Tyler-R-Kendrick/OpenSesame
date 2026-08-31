import {
  createDrizzle,
  createPostgresOidcStore,
  createRepositories,
} from "@opensesame/database";
import { createLogger } from "@opensesame/observability";
import { startCleanupLoop } from "./cleanup.js";
import {
  type ChannelAdapterRegistry,
  EMPTY_ADAPTER_REGISTRY,
} from "./notifications.js";
import { createTaskBusFromEnv } from "./taskBus.js";

export type WorkerRuntime = {
  createLogger: typeof createLogger;
  createRepositories: typeof createRepositories;
  createDrizzle: typeof createDrizzle;
  createPostgresOidcStore: typeof createPostgresOidcStore;
  startCleanupLoop: typeof startCleanupLoop;
  createTaskBusFromEnv: typeof createTaskBusFromEnv;
  /**
   * Channel adapters for this deployment (ADR 0081). Optional, and empty by
   * default: a worker with no configured adapters routes everything to the
   * durable inbox, which is honest. When
   * `@opensesame/notification-adapters` lands, this becomes
   * `createAdapterRegistry(configFromEnv())` and nothing else here changes.
   */
  createNotificationAdapters?: () => ChannelAdapterRegistry;
  exit: (code: number) => void;
};

const defaultRuntime: WorkerRuntime = {
  createLogger,
  createRepositories,
  createDrizzle,
  createPostgresOidcStore,
  startCleanupLoop,
  createTaskBusFromEnv,
  exit: (code) => {
    process.exit(code);
  },
};

/**
 * Identity-plane cleanup worker (TS). Coexists with the Rust authority worker
 * binary in this directory (`opensesame-worker`).
 */
export async function runWorker(
  runtime: WorkerRuntime = defaultRuntime,
): Promise<void> {
  const log = runtime.createLogger({ name: "worker" });
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
    runtime.exit(1);
    return;
  }
  const repos = runtime.createRepositories({ databaseUrl });
  const { db } = runtime.createDrizzle(databaseUrl);
  const oidcStore = runtime.createPostgresOidcStore(db);
  const taskBus = await runtime.createTaskBusFromEnv();
  const notificationAdapters =
    runtime.createNotificationAdapters?.() ?? EMPTY_ADAPTER_REGISTRY;
  const intervalMs = Number(
    process.env.OPENSESAME_WORKER_INTERVAL_MS ?? "5000",
  );
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  process.on("SIGTERM", () => ac.abort());

  // Claims, provisional sessions and temporary projects live in the control
  // plane's process. This worker cannot see them, and it used to be handed empty
  // maps — reporting successful ticks while expiring nothing, which reads as TTL
  // enforcement that is not happening. It publishes the outbox to TaskBus, prunes
  // the issuer's expired rows, and says so.
  log.warn(
    {
      intervalMs,
      taskBus:
        process.env.OPENSESAME_TASKBUS ??
        (process.env.NATS_URL ? "nats" : "memory"),
      // Named, not counted: "0 channels" and "slack, sms" are the difference
      // between a person who will never hear about a request and one who
      // will, and an operator should be able to read that off one line.
      notificationChannels: [...notificationAdapters.availableChannels()],
    },
    "standalone cleanup worker: outbox→TaskBus and issuer row pruning — claim, session and project expiry run in-process in the control plane",
  );
  await runtime.startCleanupLoop({
    repos,
    oidcStore,
    taskBus,
    notificationAdapters,
    clock: () => new Date(),
    log,
    intervalMs,
    signal: ac.signal,
  });
  log.info("worker stopped");
}

export async function main(): Promise<void> {
  await runWorker();
}

if (process.env.VITEST === undefined) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
