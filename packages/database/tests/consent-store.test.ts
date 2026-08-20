import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ClientRecordStore,
  type ConsentStore,
  createMemoryConsentStore,
  createPostgresClientRecordStore,
  createPostgresConsentStore,
} from "../src/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

function makeOriginClient(id: string, origin: string) {
  return {
    id,
    admissionMode: "origin_profile" as const,
    displayName: "Example app",
    redirectUris: [`${origin}/opensesame/callback`],
    sectorIdentifier: origin,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    allowedResources: [],
    state: "active" as const,
    origin,
  };
}

function consentSuite(
  name: string,
  setup: () => Promise<{
    consents: ConsentStore;
    ensureClient: (clientId: string, sector: string) => Promise<void>;
    ensurePrincipal: (principalId: string) => Promise<void>;
  }>,
) {
  describe(name, () => {
    let consents: ConsentStore;
    let ensureClient: (clientId: string, sector: string) => Promise<void>;
    let ensurePrincipal: (principalId: string) => Promise<void>;

    beforeAll(async () => {
      ({ consents, ensureClient, ensurePrincipal } = await setup());
    });

    it("saves, finds, widens, and revokes a consent", async () => {
      const principalId = `prn_${randomUUID()}`;
      const clientId = `origin:https://app-${randomUUID()}.example.com`;
      await ensurePrincipal(principalId);
      await ensureClient(clientId, clientId.slice("origin:".length));

      expect(await consents.findActive(principalId, clientId)).toBeUndefined();

      const granted = await consents.save({
        principalId,
        clientId,
        sectorIdentifier: clientId.slice("origin:".length),
        scopes: ["openid"],
        resources: [],
        claims: [],
        grantedAt: new Date(),
      });
      expect(granted.version).toBe(1);
      expect(granted.scopes).toEqual(["openid"]);
      expect(await consents.findActive(principalId, clientId)).toEqual(granted);

      // Widening unions scopes and bumps the version; nothing is dropped.
      const widened = await consents.save({
        principalId,
        clientId,
        sectorIdentifier: granted.sectorIdentifier,
        scopes: ["profile"],
        resources: [],
        claims: ["name"],
        grantedAt: new Date(),
      });
      expect(widened.id).toBe(granted.id);
      expect(widened.version).toBe(2);
      expect(widened.scopes).toEqual(["openid", "profile"]);
      expect(widened.claims).toEqual(["name"]);

      const revoked = await consents.revoke(principalId, clientId, new Date());
      expect(revoked?.revokedAt).toBeInstanceOf(Date);
      expect(await consents.findActive(principalId, clientId)).toBeUndefined();
      expect(
        await consents.revoke(principalId, clientId, new Date()),
      ).toBeUndefined();

      // A fresh consent after revocation starts a new row at version 1.
      const regranted = await consents.save({
        principalId,
        clientId,
        sectorIdentifier: granted.sectorIdentifier,
        scopes: ["openid"],
        resources: [],
        claims: [],
        grantedAt: new Date(),
      });
      expect(regranted.version).toBe(1);
      expect(regranted.id).not.toBe(granted.id);
    });
  });
}

consentSuite("createMemoryConsentStore", async () => ({
  consents: createMemoryConsentStore(),
  ensureClient: async () => {},
  ensurePrincipal: async () => {},
}));

let ctx: PgTestContext;
let clients: ClientRecordStore;

consentSuite("createPostgresConsentStore", async () => {
  ctx = await createPgTestContext();
  clients = createPostgresClientRecordStore(ctx.db);
  return {
    consents: createPostgresConsentStore(ctx.db),
    ensureClient: async (clientId, sector) => {
      await clients.insertAtomic(makeOriginClient(clientId, sector));
    },
    ensurePrincipal: async (principalId) => {
      await ctx.repos.principals.create(makePrincipal({ id: principalId }));
    },
  };
});

afterAll(async () => {
  await ctx?.client.close();
});

describe("createPostgresConsentStore races", () => {
  it("two concurrent first consents land one row with both scope sets", async () => {
    const principalId = `prn_${randomUUID()}`;
    const origin = `https://race-${randomUUID()}.example.com`;
    const clientId = `origin:${origin}`;
    await ctx.repos.principals.create(makePrincipal({ id: principalId }));
    await clients.insertAtomic(makeOriginClient(clientId, origin));
    const consents = createPostgresConsentStore(ctx.db);

    const [a, b] = await Promise.all([
      consents.save({
        principalId,
        clientId,
        sectorIdentifier: origin,
        scopes: ["openid"],
        resources: [],
        claims: [],
        grantedAt: new Date(),
      }),
      consents.save({
        principalId,
        clientId,
        sectorIdentifier: origin,
        scopes: ["profile"],
        resources: [],
        claims: [],
        grantedAt: new Date(),
      }),
    ]);

    expect(a.id).toBe(b.id);
    const live = await consents.findActive(principalId, clientId);
    expect(live?.scopes).toEqual(["openid", "profile"]);
  });
});
