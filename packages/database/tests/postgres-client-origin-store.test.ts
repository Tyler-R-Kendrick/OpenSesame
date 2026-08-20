import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ClientOriginConflictError,
  type ClientOriginStore,
  type ClientRecordStore,
  type OAuthClientRecord,
  createPostgresClientOriginStore,
  createPostgresClientRecordStore,
} from "../src/index.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
let clients: ClientRecordStore;
let origins: ClientOriginStore;

beforeAll(async () => {
  ctx = await createPgTestContext();
  clients = createPostgresClientRecordStore(ctx.db);
  origins = createPostgresClientOriginStore(ctx.db);
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

async function makeApplication(): Promise<OAuthClientRecord> {
  const origin = `https://app-${randomUUID()}.example.com`;
  return clients.insertAtomic({
    id: `origin:${origin}`,
    admissionMode: "origin_profile",
    displayName: "Example app",
    redirectUris: [`${origin}/opensesame/callback`],
    sectorIdentifier: origin,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    allowedResources: [],
    state: "active",
    origin,
  });
}

function makeAlias(applicationId: string) {
  const canonicalOrigin = `https://alias-${randomUUID()}.example.com`;
  return {
    id: `cor_${randomUUID()}`,
    applicationId,
    canonicalOrigin,
    publicClientId: `origin:${canonicalOrigin}`,
    verificationMethod: "well-known",
    status: "active" as const,
  };
}

describe("createPostgresClientOriginStore", () => {
  it("attaches an alias and finds it by origin and application", async () => {
    const app = await makeApplication();
    const alias = makeAlias(app.id);

    const inserted = await origins.insert(alias);
    expect(inserted.id).toBe(alias.id);
    expect(inserted.status).toBe("active");
    expect(inserted.verificationMethod).toBe("well-known");
    expect(inserted.createdAt).toBeInstanceOf(Date);

    expect(await origins.findByOrigin(alias.canonicalOrigin)).toEqual(inserted);
    expect(await origins.listByApplication(app.id)).toEqual([inserted]);
    expect(
      await origins.findByOrigin(`https://none-${randomUUID()}.example.com`),
    ).toBeUndefined();
    expect(
      await origins.listByApplication(`origin:nope-${randomUUID()}`),
    ).toEqual([]);
  });

  it("re-attaching the same origin to the same application is idempotent", async () => {
    const app = await makeApplication();
    const alias = makeAlias(app.id);
    const first = await origins.insert(alias);

    // A retry (e.g. a replayed verify) attaches nothing twice.
    const again = await origins.insert({ ...alias, id: `cor_${randomUUID()}` });
    expect(again.id).toBe(first.id);
    expect(await origins.listByApplication(app.id)).toHaveLength(1);
  });

  it("refuses to attach an origin already held by another application", async () => {
    const first = await makeApplication();
    const second = await makeApplication();
    const alias = makeAlias(first.id);
    await origins.insert(alias);

    await expect(
      origins.insert({
        ...alias,
        id: `cor_${randomUUID()}`,
        applicationId: second.id,
      }),
    ).rejects.toBeInstanceOf(ClientOriginConflictError);
    expect(
      (await origins.findByOrigin(alias.canonicalOrigin))?.applicationId,
    ).toBe(first.id);
  });
});
