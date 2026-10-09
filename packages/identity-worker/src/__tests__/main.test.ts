import { isFunction } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WorkerRuntime, runWorker } from "../main.js";

const ENV_KEYS = [
  "DATABASE_URL",
  "OPENSESAME_WORKER_INTERVAL_MS",
  "OPENSESAME_TASKBUS",
  "NATS_URL",
  "OPENSESAME_EVENT_KEY",
  "OPENSESAME_ALLOW_LEGACY_SECRET_MIGRATION",
] as const;

describe("worker entrypoint", () => {
  const savedEnv = new Map<string, string | undefined>();
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
  const createRepositories = vi.fn(() => ({ outbox: {} }));
  const createDrizzle = vi.fn(() => ({ db: {} }));
  const createPostgresOidcStore = vi.fn(() => ({ prune: true }));
  const startCleanupLoop = vi.fn();
  const createTaskBusFromEnv = vi.fn();
  const exit = vi.fn();
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  function runtime(): WorkerRuntime {
    return {
      createLogger: () => logger,
      createRepositories,
      createDrizzle,
      createPostgresOidcStore,
      startCleanupLoop,
      createTaskBusFromEnv,
      exit,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    startCleanupLoop.mockResolvedValue(undefined);
    createTaskBusFromEnv.mockResolvedValue({ publish: vi.fn() });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([undefined, "false", "1", "true"])(
    "requires the exact true opt-in for legacy import (%s)",
    async (flag) => {
      process.env.DATABASE_URL = "postgres://localhost/test";
      process.env.OPENSESAME_EVENT_KEY =
        "worker-startup-test-root-with-at-least-32-characters";
      if (flag !== undefined)
        process.env.OPENSESAME_ALLOW_LEGACY_SECRET_MIGRATION = flag;
      const sealLegacySecrets = vi.fn(async () => 0);
      const sealLegacyEvents = vi.fn(async () => ({
        audit: 0,
        outbox: 0,
        webhook: 0,
        notification: 0,
      }));
      await runWorker({ ...runtime(), sealLegacySecrets, sealLegacyEvents });
      expect(sealLegacyEvents).toHaveBeenCalledWith(
        {},
        expect.anything(),
        flag === "true",
      );
      expect(sealLegacySecrets).toHaveBeenCalledWith(
        {},
        expect.anything(),
        flag === "true",
      );
    },
  );

  it("builds the notification adapters from the repositories and the logger", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const registry = {
      availableChannels: () => ["native_push" as const],
      get: () => undefined,
    };
    const createNotificationAdapters = vi.fn(() => registry);

    await runWorker({ ...runtime(), createNotificationAdapters });

    expect(createNotificationAdapters).toHaveBeenCalledWith({
      repos: { outbox: {} },
      log: logger,
    });
    expect(startCleanupLoop.mock.calls[0]?.[0].notificationAdapters).toBe(
      registry,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ notificationChannels: ["native_push"] }),
      expect.stringContaining("standalone cleanup worker"),
    );
  });

  it("does not start when an adapter's configuration is unusable", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const createNotificationAdapters = vi.fn(() => {
      throw new Error("OPENSESAME_WEBPUSH_PRIVATE_KEY does not match");
    });

    await expect(
      runWorker({ ...runtime(), createNotificationAdapters }),
    ).rejects.toThrow(/does not match/u);
    expect(startCleanupLoop).not.toHaveBeenCalled();
  });

  it("refuses to start without DATABASE_URL", async () => {
    await runWorker(runtime());
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("DATABASE_URL is required"),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("wires repos, oidc store, task bus and interval into the cleanup loop", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    process.env.OPENSESAME_WORKER_INTERVAL_MS = "1500";

    await runWorker(runtime());

    expect(startCleanupLoop).toHaveBeenCalledTimes(1);
    const options = startCleanupLoop.mock.calls[0]?.[0];
    expect(options.intervalMs).toBe(1500);
    expect(options.oidcStore).toEqual({ prune: true });
    expect(options.taskBus).toBeDefined();
    expect(isFunction(options.clock)).toBe(true);
    expect(options.signal.aborted).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 1500, taskBus: "memory" }),
      expect.stringContaining("standalone cleanup worker"),
    );
    expect(logger.info).toHaveBeenCalledWith("worker stopped");
  });

  it("aborts the loop on SIGINT and SIGTERM", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";

    await runWorker(runtime());
    expect(startCleanupLoop).toHaveBeenCalledTimes(1);
    const options = startCleanupLoop.mock.calls[0]?.[0];
    expect(options.clock()).toBeInstanceOf(Date);

    process.emit("SIGINT");
    expect(options.signal.aborted).toBe(true);
    process.emit("SIGTERM");
    expect(options.signal.aborted).toBe(true);
  });

  it("uses the default interval and reports the nats bus label", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    process.env.NATS_URL = "nats://127.0.0.1:4222";

    await runWorker(runtime());

    const options = startCleanupLoop.mock.calls[0]?.[0];
    expect(options.intervalMs).toBe(5000);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskBus: "nats" }),
      expect.any(String),
    );
  });

  it("logs and exits when startup fails", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const failure = new Error("nats unreachable");
    createTaskBusFromEnv.mockRejectedValue(failure);

    await runWorker(runtime()).catch((cause) => {
      console.error(cause);
      runtime().exit(1);
    });
    expect(consoleSpy).toHaveBeenCalledWith(failure);
    expect(exit).toHaveBeenCalledWith(1);
    expect(startCleanupLoop).not.toHaveBeenCalled();
  });
});
