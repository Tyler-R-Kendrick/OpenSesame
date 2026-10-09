import { randomUUID } from "node:crypto";
import type { Organization } from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventSealError, createEventSealer } from "../src/event-seal.js";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
import { sealLegacySecrets } from "../src/repos/sealed-secrets-sweep.js";
import { organizations } from "../src/schema/index.js";
import { sealSecretText } from "../src/secret-seal.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
const sealer = createEventSealer("organization sealing fixture");

beforeAll(async () => {
  ctx = await createPgTestContext();
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

async function organization(): Promise<Organization> {
  const owner = await ctx.repos.principals.create(makePrincipal());
  const id = `org_${randomUUID()}`;
  const now = new Date();
  return {
    id,
    slug: id,
    displayName: "Customer fixture",
    state: "active",
    createdBy: owner.id,
    createdAt: now,
    updatedAt: now,
    ssoIssuer: `https://${id}.example`,
    ssoClientSecret: "sso secret fixture",
  };
}

async function storedSecret(id: string): Promise<string> {
  const [row] = await ctx.db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id));
  if (!row?.ssoClientSecret) throw new Error("missing fixture secret");
  return row.ssoClientSecret;
}

describe("organization SSO credential envelopes", () => {
  it("encrypts at rest and opens through every organization lookup", async () => {
    const store = createPostgresOrganizationStores(
      ctx.db,
      sealer,
    ).organizations;
    const org = await organization();
    await store.set(org.id, org);
    const secret = await storedSecret(org.id);
    expect(secret).toContain("osev2.");
    expect(secret).not.toContain(org.ssoClientSecret);
    expect(await store.get(org.id)).toEqual(org);
    expect(await store.getBySlug(org.slug)).toEqual(org);
    expect(await store.findByIssuer(`${org.ssoIssuer}/`)).toEqual(org);
    expect(await store.listByCreator(org.createdBy)).toEqual([org]);
  });

  it("rejects copied ciphertext from a different customer or purpose", async () => {
    const store = createPostgresOrganizationStores(
      ctx.db,
      sealer,
    ).organizations;
    const first = await organization();
    const second = await organization();
    await store.set(first.id, first);
    await store.set(second.id, second);
    const firstSecret = await storedSecret(first.id);
    await ctx.db
      .update(organizations)
      .set({ ssoClientSecret: firstSecret })
      .where(eq(organizations.id, second.id));
    await expect(store.get(second.id)).rejects.toBeInstanceOf(EventSealError);
    const otherPurpose = sealSecretText(
      sealer,
      "org_ldap_config.service_bind_secret",
      second.id,
      "ldap fixture",
    );
    await ctx.db
      .update(organizations)
      .set({ ssoClientSecret: otherPurpose })
      .where(eq(organizations.id, second.id));
    await expect(store.getBySlug(second.slug)).rejects.toBeInstanceOf(
      EventSealError,
    );
    const wrongKey = createPostgresOrganizationStores(
      ctx.db,
      createEventSealer("wrong fixture key"),
    ).organizations;
    await expect(wrongKey.get(first.id)).rejects.toBeInstanceOf(EventSealError);
    await store.set(second.id, second);
  });

  it("requires explicit legacy migration and preserves removed credential behavior", async () => {
    const legacy = createPostgresOrganizationStores(ctx.db).organizations;
    const store = createPostgresOrganizationStores(
      ctx.db,
      sealer,
    ).organizations;
    const org = await organization();
    await legacy.set(org.id, org);
    expect(await storedSecret(org.id)).toBe(org.ssoClientSecret);
    await expect(store.get(org.id)).rejects.toBeInstanceOf(EventSealError);
    await sealLegacySecrets(ctx.db, sealer);
    expect(await store.get(org.id)).toEqual(org);
    await store.set(org.id, org);
    expect(await storedSecret(org.id)).toContain("osev2.");
    const { ssoClientSecret: _secret, ...withoutSecret } = org;
    await store.set(org.id, withoutSecret);
    expect((await store.get(org.id))?.ssoClientSecret).toBeUndefined();
  });
});
