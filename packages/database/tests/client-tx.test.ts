import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryRepositories,
  PostgresRepositories,
  createDrizzle,
  createRepositories,
  createSqlClient,
  resetDatabase,
  runMigrations,
  withOutbox,
} from "../src/index.js";
import {
  ConflictError,
  NotFoundError,
  OUTBOX_CLAIM_HOLD_MS,
  outboxClaimToken,
  outboxHoldActive,
} from "../src/repos/interfaces.js";
import { isFunction } from "@opensesame/os-domain";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createRepositories", () => {
  it("falls back to in-memory repositories without a database URL", () => {
    vi.stubEnv("DATABASE_URL", "");
    const repos = createRepositories();
    expect(repos).toBeInstanceOf(MemoryRepositories);
  });

  it("prefers Postgres when a database URL is given explicitly", () => {
    const repos = createRepositories({
      databaseUrl: "postgres://localhost:1/opensesame_test",
    });
    expect(repos).toBeInstanceOf(PostgresRepositories);
  });

  it("prefers Postgres when DATABASE_URL is set in the environment", () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost:1/opensesame_test");
    const repos = createRepositories();
    expect(repos).toBeInstanceOf(PostgresRepositories);
  });
});

describe("createSqlClient / createDrizzle", () => {
  it("builds a lazy client and drizzle handle without connecting", async () => {
    const sql = createSqlClient("postgres://localhost:1/opensesame_test");
    expect(isFunction(sql)).toBe(true);
    await sql.end({ timeout: 1 });

    const handle = createDrizzle("postgres://localhost:1/opensesame_test");
    expect(handle.db).toBeDefined();
    expect(handle.sql).toBeDefined();
    await handle.sql.end({ timeout: 1 });
  });
});

describe("error types", () => {
  it("carry stable names for instanceof-free checks", () => {
    expect(new ConflictError("x").name).toBe("ConflictError");
    expect(new NotFoundError("x").name).toBe("NotFoundError");
    expect(new NotFoundError("x").message).toBe("x");
  });
});

describe("outbox hold helpers", () => {
  const now = new Date("2026-08-19T00:00:00.000Z");

  it("no hold without a claim token", () => {
    expect(outboxHoldActive(undefined, now)).toBe(false);
    expect(outboxHoldActive("nats down", now)).toBe(false);
    expect(outboxHoldActive("claim:not-a-number", now)).toBe(false);
  });

  it("hold is active until its deadline, inclusive of nothing after", () => {
    const live = `claim:${now.getTime() + 1}`;
    expect(outboxHoldActive(live, now)).toBe(true);
    const expired = `claim:${now.getTime()}`;
    expect(outboxHoldActive(expired, now)).toBe(false);
  });

  it("outboxClaimToken encodes now + hold with a default hold", () => {
    expect(outboxClaimToken(now)).toBe(
      `claim:${now.getTime() + OUTBOX_CLAIM_HOLD_MS}`,
    );
    expect(outboxClaimToken(now, 5)).toBe(`claim:${now.getTime() + 5}`);
  });
});

describe("withOutbox", () => {
  it("rolls back the domain write when the work fails", async () => {
    const repos = new MemoryRepositories();
    const principalId = `prn_${randomUUID()}`;
    await expect(
      withOutbox(
        repos,
        {
          id: `ob_${randomUUID()}`,
          aggregateType: "principal",
          aggregateId: principalId,
          eventType: "principal.created",
          payload: {},
        },
        async (uow) => {
          await repos.principals.create(
            {
              id: principalId,
              state: "active",
              assurance: "provisional",
              createdAt: new Date(),
              updatedAt: new Date(),
              version: 1,
            },
            uow,
          );
          throw new Error("work failed");
        },
      ),
    ).rejects.toThrow("work failed");
    expect(await repos.principals.getById(principalId)).toBeNull();
    expect(await repos.outbox.listUnpublished()).toEqual([]);
  });
});

describe("runMigrations / resetDatabase against an unreachable server", () => {
  // No DATABASE_URL-backed server exists in unit tests; these exercise the
  // failure path: the error propagates and the client is still closed.
  it("runMigrations propagates the connection failure", async () => {
    await expect(
      runMigrations("postgres://127.0.0.1:1/opensesame_test"),
    ).rejects.toThrow();
  }, 60_000);

  it("resetDatabase propagates the connection failure", async () => {
    await expect(
      resetDatabase("postgres://127.0.0.1:1/opensesame_test"),
    ).rejects.toThrow();
  }, 60_000);
});
