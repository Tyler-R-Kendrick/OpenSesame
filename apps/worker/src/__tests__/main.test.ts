import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
  createRepositories: vi.fn(() => ({ outbox: {} })),
  createDrizzle: vi.fn(() => ({ db: {} })),
  createPostgresOidcStore: vi.fn(() => ({ prune: true })),
  startCleanupLoop: vi.fn(),
  createTaskBusFromEnv: vi.fn(),
}));

vi.mock("@opensesame/database", () => ({
  createRepositories: mocks.createRepositories,
  createDrizzle: mocks.createDrizzle,
  createPostgresOidcStore: mocks.createPostgresOidcStore,
}));

vi.mock("@opensesame/observability", () => ({
  createLogger: () => mocks.logger,
}));

vi.mock("../cleanup.js", () => ({
  startCleanupLoop: mocks.startCleanupLoop,
}));

vi.mock("../taskBus.js", () => ({
  createTaskBusFromEnv: mocks.createTaskBusFromEnv,
}));

const ENV_KEYS = [
  "DATABASE_URL",
  "OPENSESAME_WORKER_INTERVAL_MS",
  "OPENSESAME_TASKBUS",
  "NATS_URL",
] as const;

describe("worker entrypoint", () => {
  const savedEnv = new Map<string, string | undefined>();
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    mocks.startCleanupLoop.mockResolvedValue(undefined);
    mocks.createTaskBusFromEnv.mockResolvedValue({ publish: vi.fn() });
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("refuses to start without DATABASE_URL", async () => {
    await import("../main.js");
    await vi.waitFor(() => {
      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("DATABASE_URL is required"),
      );
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("wires repos, oidc store, task bus and interval into the cleanup loop", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    process.env.OPENSESAME_WORKER_INTERVAL_MS = "1500";

    await import("../main.js");
    await vi.waitFor(() => {
      expect(mocks.startCleanupLoop).toHaveBeenCalledTimes(1);
    });

    const options = mocks.startCleanupLoop.mock.calls[0]?.[0];
    expect(options.intervalMs).toBe(1500);
    expect(options.oidcStore).toEqual({ prune: true });
    expect(options.taskBus).toBeDefined();
    expect(typeof options.clock).toBe("function");
    expect(options.signal.aborted).toBe(false);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 1500, taskBus: "memory" }),
      expect.stringContaining("standalone cleanup worker"),
    );
    expect(mocks.logger.info).toHaveBeenCalledWith("worker stopped");
  });

  it("aborts the loop on SIGINT and SIGTERM", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";

    await import("../main.js");
    await vi.waitFor(() => {
      expect(mocks.startCleanupLoop).toHaveBeenCalledTimes(1);
    });
    const options = mocks.startCleanupLoop.mock.calls[0]?.[0];
    // The loop's clock is wall time, not a fake.
    expect(options.clock()).toBeInstanceOf(Date);

    process.emit("SIGINT");
    expect(options.signal.aborted).toBe(true);
    process.emit("SIGTERM");
    expect(options.signal.aborted).toBe(true);
  });

  it("uses the default interval and reports the nats bus label", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    process.env.NATS_URL = "nats://127.0.0.1:4222";

    await import("../main.js");
    await vi.waitFor(() => {
      expect(mocks.startCleanupLoop).toHaveBeenCalledTimes(1);
    });

    const options = mocks.startCleanupLoop.mock.calls[0]?.[0];
    expect(options.intervalMs).toBe(5000);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskBus: "nats" }),
      expect.any(String),
    );
  });

  it("logs and exits when startup fails", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const failure = new Error("nats unreachable");
    mocks.createTaskBusFromEnv.mockRejectedValue(failure);

    await import("../main.js");
    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(failure);
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.startCleanupLoop).not.toHaveBeenCalled();
  });
});
