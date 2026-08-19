import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ClaimSession,
  ExternalIdentity,
  Principal,
} from "@opensesame/os-domain";
import {
  ConflictError,
  MemoryRepositories,
  withOutbox,
} from "../src/index.js";

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  const now = new Date();
  return {
    id: overrides.id ?? randomUUID(),
    state: "active",
    assurance: "provisional",
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

function makeIdentity(
  principalId: string,
  overrides: Partial<ExternalIdentity> = {},
): ExternalIdentity {
  return {
    id: overrides.id ?? randomUUID(),
    principalId,
    kind: "oidc",
    issuer: "https://idp.example",
    subject: overrides.subject ?? randomUUID(),
    assurance: "verified",
    linkedAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeClaim(overrides: Partial<ClaimSession> = {}): ClaimSession {
  const now = new Date();
  return {
    id: overrides.id ?? randomUUID(),
    type: "resource_bundle",
    state: "pending",
    tokenDigest: overrides.tokenDigest ?? new Uint8Array([1, 2, 3, 4]),
    targetManifest: {},
    targetManifestDigest: "sha256:deadbeef",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    version: 1,
    ...overrides,
  };
}

describe("MemoryRepositories", () => {
  it("creates a principal", async () => {
    const repos = new MemoryRepositories();
    const principal = makePrincipal();
    const created = await repos.principals.create(principal);
    expect(created.id).toBe(principal.id);
    expect(await repos.principals.getById(principal.id)).toEqual(created);
  });

  it("cloneClaim isolates reviewDecision mutations", async () => {
    const repos = new MemoryRepositories();
    const created = await repos.claimSessions.create(
      makeClaim({
        reviewDecision: { verdict: "allow", nested: { note: "orig" } },
      }),
    );
    const loaded = await repos.claimSessions.getById(created.id);
    expect(loaded?.reviewDecision).toEqual({
      verdict: "allow",
      nested: { note: "orig" },
    });
    (loaded?.reviewDecision as { nested: { note: string } }).nested.note =
      "mutated";
    const again = await repos.claimSessions.getById(created.id);
    expect(again?.reviewDecision).toEqual({
      verdict: "allow",
      nested: { note: "orig" },
    });
  });

  it("rejects external identity unique collision on kind+issuer+tenant+subject", async () => {
    const repos = new MemoryRepositories();
    const a = await repos.principals.create(makePrincipal());
    const b = await repos.principals.create(makePrincipal());

    await repos.externalIdentities.create(
      makeIdentity(a.id, {
        kind: "oidc",
        issuer: "https://idp.example",
        tenant: "acme",
        subject: "user-1",
      }),
    );

    await expect(
      repos.externalIdentities.create(
        makeIdentity(b.id, {
          kind: "oidc",
          issuer: "https://idp.example",
          tenant: "acme",
          subject: "user-1",
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("does not enforce email uniqueness", async () => {
    const repos = new MemoryRepositories();
    const a = await repos.principals.create(makePrincipal());
    const b = await repos.principals.create(makePrincipal());

    await repos.externalIdentities.create(
      makeIdentity(a.id, {
        subject: "sub-a",
        emailNormalized: "same@example.com",
      }),
    );
    await repos.externalIdentities.create(
      makeIdentity(b.id, {
        subject: "sub-b",
        emailNormalized: "same@example.com",
      }),
    );

    const matches =
      await repos.externalIdentities.listByEmailNormalized("same@example.com");
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((m) => m.principalId))).toEqual(
      new Set([a.id, b.id]),
    );
  });

  it("enforces claim row version CAS", async () => {
    const repos = new MemoryRepositories();
    const claim = await repos.claimSessions.create(makeClaim({ version: 1 }));

    const updated = await repos.claimSessions.updateWithVersion(claim.id, 1, {
      state: "presented",
      presentedAt: new Date(),
    });
    expect(updated.version).toBe(2);
    expect(updated.state).toBe("presented");

    await expect(
      repos.claimSessions.updateWithVersion(claim.id, 1, {
        state: "authenticated",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const again = await repos.claimSessions.updateWithVersion(claim.id, 2, {
      state: "authenticated",
      authenticatedAt: new Date(),
    });
    expect(again.version).toBe(3);
  });

  it("appends outbox in the same transaction as domain writes", async () => {
    const repos = new MemoryRepositories();
    const principal = makePrincipal();

    const { result, outbox } = await withOutbox(
      repos,
      {
        id: randomUUID(),
        aggregateType: "principal",
        aggregateId: principal.id,
        eventType: "principal.created",
        payload: { principalId: principal.id },
      },
      async (uow) => {
        return repos.principals.create(principal, uow);
      },
    );

    expect(result.id).toBe(principal.id);
    expect(outbox.eventType).toBe("principal.created");
    const unpublished = await repos.outbox.listUnpublished();
    expect(unpublished.map((e) => e.id)).toContain(outbox.id);
  });
});
