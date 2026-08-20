import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryClientRecordStore } from "../clients/store.js";
import type { OAuthClientRecord } from "../types.js";

function makeOriginClient(
  overrides: Partial<OAuthClientRecord> = {},
): OAuthClientRecord {
  const origin = overrides.origin ?? "https://app.example";
  const id = overrides.id ?? `origin:${origin}`;
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id,
    admissionMode: "origin_profile",
    displayName: "Static site",
    redirectUris: [`${origin}/opensesame/callback`],
    sectorIdentifier: "sector-test",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    allowedResources: [],
    state: "active",
    origin,
    ownershipStatus: "unclaimed",
    firstSeenAt: now,
    lastUsedAt: now,
    ...overrides,
  };
}

// The unique-violation reload contract every ClientRecordStore must satisfy
// (Postgres implementation lands with the migration slice — ADR 0050 R-C).
describe("MemoryClientRecordStore insertAtomic", () => {
  it("returns the inserted client on first write", async () => {
    const store = new MemoryClientRecordStore();
    const client = makeOriginClient({ id: `first-${randomUUID()}` });
    const inserted = await store.insertAtomic(client);
    expect(inserted.id).toBe(client.id);
    expect(inserted.origin).toBe(client.origin);
    expect(await store.findById(client.id)).toEqual(inserted);
  });

  it("returns existing row on id conflict (sequential race)", async () => {
    const store = new MemoryClientRecordStore();
    const origin = `https://race-id-${randomUUID()}.example`;
    const first = makeOriginClient({ id: `origin:${origin}`, origin });
    const winner = await store.insertAtomic(first);

    const loser = makeOriginClient({
      id: first.id,
      origin: `https://other-${randomUUID()}.example`,
      displayName: "Should not win",
    });
    const resolved = await store.insertAtomic(loser);
    expect(resolved.id).toBe(winner.id);
    expect(resolved.origin).toBe(winner.origin);
    expect(resolved.displayName).toBe(winner.displayName);
  });

  it("returns existing row on origin conflict (sequential race)", async () => {
    const store = new MemoryClientRecordStore();
    const origin = `https://race-origin-${randomUUID()}.example`;
    const first = makeOriginClient({ id: `origin:${origin}`, origin });
    const winner = await store.insertAtomic(first);

    const loser = makeOriginClient({
      id: `origin:https://different-${randomUUID()}.example`,
      origin,
      displayName: "Duplicate origin",
    });
    const resolved = await store.insertAtomic(loser);
    expect(resolved.id).toBe(winner.id);
    expect(resolved.origin).toBe(origin);
    expect(await store.findByOrigin(origin)).toEqual(winner);
  });

  it("resolves concurrent first-seen inserts to a single winner", async () => {
    const store = new MemoryClientRecordStore();
    const origin = `https://race-${randomUUID()}.example`;
    const a = makeOriginClient({ id: `origin:${origin}`, origin });
    const b = makeOriginClient({ id: `origin:${origin}`, origin });
    const [first, second] = await Promise.all([
      store.insertAtomic(a),
      store.insertAtomic(b),
    ]);
    expect(second).toBe(first);
    expect(await store.findById(a.id)).toBe(first);
  });

  it("touchLastUsed updates lastUsedAt without disturbing other fields", async () => {
    const store = new MemoryClientRecordStore();
    const client = makeOriginClient({ id: `touch-${randomUUID()}` });
    await store.insertAtomic(client);
    const later = new Date("2026-02-01T00:00:00.000Z");
    await store.touchLastUsed(client.id, later);
    const persisted = await store.findById(client.id);
    expect(persisted?.lastUsedAt).toEqual(later);
    expect(persisted?.firstSeenAt).toEqual(client.firstSeenAt);
    // Unknown ids are ignored.
    await expect(
      store.touchLastUsed("missing", later),
    ).resolves.toBeUndefined();
  });
});
