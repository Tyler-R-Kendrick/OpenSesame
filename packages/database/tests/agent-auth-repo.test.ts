import type { AgentRegistration } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { MemoryAgentAuthRepository } from "../src/repos/agent-auth-repo.js";
import { ConflictError, type UnitOfWork } from "../src/repos/interfaces.js";

type Deferred = UnitOfWork & {
  commit(): void;
};

function registration(
  overrides: Partial<AgentRegistration> = {},
): AgentRegistration {
  const now = new Date("2026-09-02T12:00:00.000Z");
  return {
    id: "areg_1",
    kind: "anonymous",
    status: "unclaimed",
    principalId: "prn_1",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 1000),
    preClaimScopes: ["resource:read"],
    postClaimScopes: ["resource:read"],
    assertionVersion: 1,
    version: 1,
    ...overrides,
  };
}

function deferredUow(): Deferred {
  const ops: Array<() => void> = [];
  return {
    defer(op: () => void) {
      ops.push(op);
    },
    async appendOutbox() {
      throw new Error("agent-auth tests do not write outbox events");
    },
    commit() {
      for (const op of ops) op();
    },
  };
}

describe("MemoryAgentAuthRepository", () => {
  it("compare-and-set fails on a stale version", async () => {
    const repo = new MemoryAgentAuthRepository();
    const created = await repo.createRegistration(registration());
    await repo.compareAndSetRegistration(created.version, {
      ...created,
      status: "claim_pending",
    });
    await expect(
      repo.compareAndSetRegistration(created.version, {
        ...created,
        status: "claimed",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("does not apply a registration until the unit of work commits", async () => {
    const repo = new MemoryAgentAuthRepository();
    const uow = deferredUow();
    await repo.createRegistration(registration({ id: "areg_tx" }), uow);
    expect(await repo.getRegistrationById("areg_tx")).toBeNull();
    uow.commit();
    expect(await repo.getRegistrationById("areg_tx")).not.toBeNull();
  });

  it("rolls back a deferred create when the unit of work never commits", async () => {
    const repo = new MemoryAgentAuthRepository();
    const uow = deferredUow();
    await repo.createRegistration(registration({ id: "areg_drop" }), uow);
    expect(await repo.getRegistrationById("areg_drop")).toBeNull();
  });

  it("admits at most one deferred create of the same id", async () => {
    const repo = new MemoryAgentAuthRepository();
    const first = deferredUow();
    const second = deferredUow();
    await repo.createRegistration(registration({ id: "areg_race" }), first);
    await repo.createRegistration(registration({ id: "areg_race" }), second);
    first.commit();
    expect(() => second.commit()).toThrow(ConflictError);
    expect((await repo.getRegistrationById("areg_race"))?.version).toBe(1);
  });

  it("admits at most one deferred compare-and-set of the same version", async () => {
    const repo = new MemoryAgentAuthRepository();
    const created = await repo.createRegistration(registration());
    const first = deferredUow();
    const second = deferredUow();
    await repo.compareAndSetRegistration(
      created.version,
      { ...created, status: "claim_pending" },
      first,
    );
    await repo.compareAndSetRegistration(
      created.version,
      { ...created, status: "revoked" },
      second,
    );
    first.commit();
    expect(() => second.commit()).toThrow(ConflictError);
    expect((await repo.getRegistrationById(created.id))?.status).toBe(
      "claim_pending",
    );
  });

  it("expireDue leaves claimed registrations in place", async () => {
    const repo = new MemoryAgentAuthRepository();
    const now = new Date("2026-09-02T12:00:00.000Z");
    await repo.createRegistration(
      registration({
        status: "claimed",
        expiresAt: new Date(now.getTime() - 1),
      }),
    );
    expect(await repo.expireDue(now)).toBe(0);
    expect((await repo.getRegistrationById("areg_1"))?.status).toBe("claimed");
  });
});
