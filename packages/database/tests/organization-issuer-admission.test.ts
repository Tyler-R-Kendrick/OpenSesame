import { randomUUID } from "node:crypto";
import type { Organization } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  type OrganizationStore,
} from "../src/repos/interfaces.js";
import { MemoryOrganizationStore } from "../src/repos/memory.js";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
import { organizations } from "../src/schema/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
let owner: string;
beforeAll(async () => {
  ctx = await createPgTestContext();
  owner = (await ctx.repos.principals.create(makePrincipal())).id;
}, 60_000);
afterAll(async () => {
  await ctx.client.close();
});

function org(patch: Partial<Organization> = {}): Organization {
  const id = randomUUID();
  return {
    id,
    slug: id,
    displayName: id,
    state: "active",
    createdBy: owner,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...patch,
  };
}

for (const backend of ["memory", "postgres"] as const) {
  describe(`${backend} organization issuer admission`, () => {
    const store = (): OrganizationStore =>
      backend === "memory"
        ? new MemoryOrganizationStore()
        : createPostgresOrganizationStores(ctx.db).organizations;

    it("admits only one concurrent normalized SSO/SAML issuer claimant", async () => {
      const a = store();
      // Separate adapters on a shared database model separate server replicas.
      const b = backend === "memory" ? a : store();
      const issuer = `https://${randomUUID()}.example`;
      const first = org({ ssoIssuer: `\t\ufeff${issuer}/\n\u3000` });
      const second = org({ samlIssuer: issuer });
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => a.set(first.id, first)),
        Promise.resolve().then(() => b.set(second.id, second)),
      ]);
      expect(
        outcomes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(await a.findByIssuer(issuer)).toBeDefined();
    });

    it("preserves same-owner aliases, rejects conflicting updates, and releases removed claims", async () => {
      const s = store();
      const issuer = `https://${randomUUID()}.example`;
      const first = org({ ssoIssuer: issuer, samlIssuer: `${issuer}/` });
      const second = org();
      await s.set(first.id, first);
      await s.set(second.id, second);
      await expect(
        Promise.resolve().then(() =>
          s.set(second.id, { ...second, samlIssuer: issuer }),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect((await s.get(second.id))?.samlIssuer).toBeUndefined();
      const { ssoIssuer: _sso, samlIssuer: _saml, ...unclaimed } = first;
      await s.set(first.id, unclaimed);
      await s.set(second.id, { ...second, samlIssuer: issuer });
      expect((await s.findByIssuer(`${issuer}/`))?.id).toBe(second.id);
    });
  });
}

it("refuses ambiguous legacy issuer rows rather than selecting a tenant", async () => {
  const issuer = `https://${randomUUID()}.example`;
  const first = org({ ssoIssuer: issuer });
  const second = org({ samlIssuer: `${issuer}/` });
  await ctx.db.insert(organizations).values([first, second]);
  const store = createPostgresOrganizationStores(ctx.db).organizations;
  expect(await store.findByIssuer(issuer)).toBeUndefined();
});
