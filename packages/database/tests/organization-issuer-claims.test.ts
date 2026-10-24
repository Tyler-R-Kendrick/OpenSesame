import { randomUUID } from "node:crypto";
import type { Organization } from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEventSealer } from "../src/event-seal.js";
import {
  OrganizationIssuerConflictError,
  type OrganizationStore,
} from "../src/repos/interfaces.js";
import { MemoryOrganizationStore } from "../src/repos/memory.js";
import { PostgresOrganizationStore } from "../src/repos/postgres.js";
import { organizations } from "../src/schema/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
let creator: string;
const sealer = createEventSealer("organization issuer ownership fixture");
const whitespace =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const protocols = ["ssoIssuer", "samlIssuer"] as const;

beforeAll(async () => {
  ctx = await createPgTestContext();
  creator = (await ctx.repos.principals.create(makePrincipal())).id;
}, 60_000);

afterAll(async () => {
  await ctx?.client.close();
});

function issuer(): string {
  return `https://issuer-${randomUUID()}.example/tenant`;
}

function organization(overrides: Partial<Organization> = {}): Organization {
  const id = `org_${randomUUID()}`;
  return {
    id,
    slug: id,
    displayName: "Issuer ownership fixture",
    state: "active",
    createdBy: creator,
    createdAt: new Date(),
    updatedAt: new Date(),
    ssoClientId: "original-client",
    ssoClientSecret: "original-secret",
    samlMetadataXml: "<original-metadata/>",
    ...overrides,
  };
}

async function set(store: OrganizationStore, row: Organization): Promise<void> {
  await store.set(row.id, row);
}

for (const backend of ["memory", "postgres"] as const) {
  describe(`${backend} organization issuer ownership`, () => {
    let store: OrganizationStore;

    function stores(): [OrganizationStore, OrganizationStore] {
      if (backend === "memory") {
        const shared = new MemoryOrganizationStore();
        return [shared, shared];
      }
      return [
        new PostgresOrganizationStore(ctx.db, sealer),
        new PostgresOrganizationStore(ctx.db, sealer),
      ];
    }

    beforeAll(() => {
      [store] = stores();
    });

    for (const first of protocols) {
      for (const second of protocols) {
        it(`rejects ${first} to ${second} whitespace and slash aliases`, async () => {
          const key = issuer();
          const owner = organization({
            [first]: `${whitespace}${key}///${whitespace}`,
          });
          await set(store, owner);
          expect(await store.findByIssuer(`${key}/`)).toEqual(owner);
          for (const space of whitespace) {
            const contender = organization({
              [second]: `${space}${key}/${space}`,
            });
            await expect(set(store, contender)).rejects.toBeInstanceOf(
              OrganizationIssuerConflictError,
            );
            expect(await store.get(contender.id)).toBeUndefined();
          }
          expect(await store.get(owner.id)).toEqual(owner);
        });
      }
    }

    it("allows the same owner to hold both protocols and repeat a full-row write", async () => {
      const key = issuer();
      const row = organization({ ssoIssuer: `${key}/`, samlIssuer: key });
      await set(store, row);
      await set(store, row);
      expect(await store.findByIssuer(key)).toEqual(row);
      const { ssoIssuer: _removed, ...samlOnly } = row;
      await set(store, samlOnly);
      await expect(
        set(store, organization({ ssoIssuer: key })),
      ).rejects.toBeInstanceOf(OrganizationIssuerConflictError);
      const { samlIssuer: _alsoRemoved, ...bare } = samlOnly;
      await set(store, bare);
      expect(await store.findByIssuer(key)).toBeUndefined();
      const next = organization({ ssoIssuer: key });
      await set(store, next);
      expect(await store.findByIssuer(key)).toEqual(next);
    });

    it("rolls back the whole row and retains old claims after a conflict", async () => {
      const held = issuer();
      const originalIssuer = issuer();
      const owner = organization({ ssoIssuer: held });
      const original = organization({ samlIssuer: originalIssuer });
      await set(store, owner);
      await set(store, original);
      await expect(
        set(store, {
          ...original,
          samlIssuer: `${held}/`,
          displayName: "must not publish",
          ssoClientId: "must-not-publish",
          ssoClientSecret: "must-not-publish",
          samlMetadataXml: "<must-not-publish/>",
        }),
      ).rejects.toBeInstanceOf(OrganizationIssuerConflictError);
      expect(await store.get(original.id)).toEqual(original);
      expect(await store.findByIssuer(originalIssuer)).toEqual(original);
      expect(await store.findByIssuer(held)).toEqual(owner);
    });

    it("releases a replaced issuer while preserving its new owner", async () => {
      const old = issuer();
      const replacement = issuer();
      const row = organization({ ssoIssuer: old });
      await set(store, row);
      await set(store, { ...row, ssoIssuer: replacement });
      const next = organization({ samlIssuer: `${old}/` });
      await set(store, next);
      expect((await store.findByIssuer(old))?.id).toBe(next.id);
      expect((await store.findByIssuer(replacement))?.id).toBe(row.id);
    });

    it("preserves case-sensitive entity IDs and ignores empty normalized issuers", async () => {
      const prefix = issuer();
      const upper = organization({ samlIssuer: `${prefix}/A` });
      const lower = organization({ ssoIssuer: `${prefix}/a` });
      await set(store, upper);
      await set(store, lower);
      await set(store, organization({ samlIssuer: " /// " }));
      await set(store, organization({ ssoIssuer: "\t///\n" }));
      expect(await store.findByIssuer(`${prefix}/A`)).toEqual(upper);
      expect(await store.findByIssuer(`${prefix}/a`)).toEqual(lower);
      expect(await store.findByIssuer(" /// ")).toBeUndefined();
    });

    for (const state of [
      "provisional",
      "active",
      "suspended",
      "deleted",
    ] as const) {
      it(`retains ownership for ${state} organizations`, async () => {
        const key = issuer();
        const owner = organization({ state, ssoIssuer: key });
        await set(store, owner);
        await expect(
          set(store, organization({ samlIssuer: `${key}/` })),
        ).rejects.toBeInstanceOf(OrganizationIssuerConflictError);
        expect(await store.findByIssuer(key)).toEqual(owner);
      });
    }

    for (const mode of [
      "create/create",
      "create/update",
      "update/update",
    ] as const) {
      it(`arbitrates concurrent ${mode} writes through independent stores`, async () => {
        const [a, b] = stores();
        const key = issuer();
        const first = organization();
        const second = organization();
        const updateFirst = mode === "update/update";
        const updateSecond = mode !== "create/create";
        if (updateFirst) await set(a, first);
        if (updateSecond) await set(b, second);
        const candidates = [
          { ...first, displayName: "first changed", ssoIssuer: key },
          { ...second, displayName: "second changed", samlIssuer: `${key}/` },
        ] as const;
        const results = await Promise.allSettled([
          set(a, candidates[0]),
          set(b, candidates[1]),
        ]);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const loserIndex = results.findIndex(
          (result) => result.status === "rejected",
        );
        const rejected = results[loserIndex];
        if (rejected?.status !== "rejected")
          throw new Error("no losing contender");
        expect(rejected.reason).toBeInstanceOf(OrganizationIssuerConflictError);
        const loser = loserIndex === 0 ? first : second;
        const existed = loserIndex === 0 ? updateFirst : updateSecond;
        expect(await a.get(loser.id)).toEqual(existed ? loser : undefined);
        expect((await a.findByIssuer(key))?.id).toBe(
          candidates[1 - loserIndex]?.id,
        );
      });
    }
  });
}

it("enforces ownership on direct SQL inserts and updates too", async () => {
  const store = new PostgresOrganizationStore(ctx.db);
  const key = issuer();
  const owner = organization({ ssoIssuer: key });
  const other = organization();
  await store.set(owner.id, owner);
  await store.set(other.id, other);
  const foreign = organization({ samlIssuer: `${key}/` });
  await expect(ctx.db.insert(organizations).values(foreign)).rejects.toThrow();
  expect(await store.get(foreign.id)).toBeUndefined();
  await expect(
    ctx.db
      .update(organizations)
      .set({
        samlIssuer: key,
        displayName: "must not publish",
      })
      .where(eq(organizations.id, other.id)),
  ).rejects.toThrow();
  expect(await store.get(other.id)).toEqual(other);
});
