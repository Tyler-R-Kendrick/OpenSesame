import { randomUUID } from "node:crypto";
import type {
  ByoUpstream,
  OrgLdapConfig,
  Organization,
} from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OrgEmailDomainConflictError,
  type OrgFederationStores,
  createMemoryOrgFederationStores,
  createPostgresOrgFederationStores,
} from "../src/org-federation-store.js";
import type {
  OrganizationStores,
  Repositories,
} from "../src/repos/interfaces.js";
import {
  MemoryRepositories,
  createMemoryOrganizationStores,
} from "../src/repos/memory.js";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
import {
  type SamlStores,
  createMemorySamlStores,
  createPostgresSamlStores,
} from "../src/saml-store.js";
import {
  type ScimStores,
  type ScimUserRecord,
  createMemoryScimStores,
  createPostgresScimStores,
} from "../src/scim-store.js";
import { makeIdentity, makePrincipal } from "./factories.js";
import { createPgTestContext } from "./pg-harness-full.js";

/**
 * One spec, both implementations (T8).
 *
 * The memory store is a first-class implementation, not a test double: the
 * control plane runs on it whenever DATABASE_URL is unset, so a field it
 * silently drops (or keeps, where Postgres nulls it) is a production
 * divergence. Running the identical assertions against a fully migrated
 * in-process Postgres is the only thing that catches it.
 */
interface FederationBackend {
  repos: Repositories;
  organizations: OrganizationStores;
  saml: SamlStores;
  scim: ScimStores;
  federation: OrgFederationStores;
  close(): Promise<void>;
}

async function memoryBackend(): Promise<FederationBackend> {
  return {
    repos: new MemoryRepositories(),
    organizations: createMemoryOrganizationStores(),
    saml: createMemorySamlStores(),
    scim: createMemoryScimStores(),
    federation: createMemoryOrgFederationStores(),
    close: async () => {},
  };
}

async function postgresBackend(): Promise<FederationBackend> {
  const ctx = await createPgTestContext();
  return {
    repos: ctx.repos,
    organizations: createPostgresOrganizationStores(ctx.db),
    saml: createPostgresSamlStores(ctx.db),
    scim: createPostgresScimStores(ctx.db),
    federation: createPostgresOrgFederationStores(ctx.db),
    close: async () => {
      await ctx.client.close();
    },
  };
}

const backends = [
  { name: "memory", create: memoryBackend },
  { name: "postgres", create: postgresBackend },
] as const;

describe.each(backends)("$name federation storage", ({ create }) => {
  let backend: FederationBackend;

  beforeAll(async () => {
    backend = await create();
  }, 60_000);

  afterAll(async () => {
    await backend.close();
  });

  async function principal(overrides = {}): Promise<string> {
    const row = await backend.repos.principals.create(makePrincipal(overrides));
    return row.id;
  }

  async function seedOrganization(
    overrides: Partial<Organization> = {},
  ): Promise<Organization> {
    const createdBy = overrides.createdBy ?? (await principal());
    const now = new Date("2026-08-24T09:00:00.000Z");
    const organization: Organization = {
      id: `org_${randomUUID()}`,
      slug: `acme-${randomUUID().slice(0, 8)}`,
      displayName: "Acme",
      state: "active",
      createdBy,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    await backend.organizations.organizations.set(
      organization.id,
      organization,
    );
    return organization;
  }

  function byoUpstream(overrides: Partial<ByoUpstream> = {}): ByoUpstream {
    return {
      id: `byo_${randomUUID()}`,
      issuer: `https://idp-${randomUUID().slice(0, 8)}.example`,
      label: "idp.example",
      clientId: "client-abc",
      clientAuth: "none",
      registrationSource: "manual",
      state: "active",
      createdAt: new Date("2026-08-24T09:00:00.000Z"),
      ...overrides,
    };
  }

  describe("organization store", () => {
    it("round-trips a full row and keeps unset optionals absent", async () => {
      const organization = await seedOrganization({
        ssoIssuer: "https://sso.acme.example",
        samlIssuer: "https://saml.acme.example",
        samlMetadataUrl: "https://saml.acme.example/metadata",
        samlMetadataXml: "<EntityDescriptor />",
        provisioningEnabled: true,
      });
      expect(
        await backend.organizations.organizations.get(organization.id),
      ).toEqual(organization);

      const bare = await seedOrganization();
      const read = await backend.organizations.organizations.get(bare.id);
      expect(read).toEqual(bare);
      // Null-vs-undefined: an unset column reads back as an absent key, never
      // as `null` and never as `false`.
      expect(Object.hasOwn(read ?? {}, "ssoIssuer")).toBe(false);
      expect(Object.hasOwn(read ?? {}, "samlMetadataXml")).toBe(false);
      expect(Object.hasOwn(read ?? {}, "provisioningEnabled")).toBe(false);
    });

    it("drops an explicitly false provisioning flag on write", async () => {
      const organization = await seedOrganization({
        provisioningEnabled: false,
      });
      const read = await backend.organizations.organizations.get(
        organization.id,
      );
      expect(Object.hasOwn(read ?? {}, "provisioningEnabled")).toBe(false);
    });

    it("set is a full-row upsert: clearing an optional clears the column", async () => {
      const organization = await seedOrganization({
        ssoIssuer: "https://sso.acme.example",
      });
      const { ssoIssuer: _cleared, ...rest } = organization;
      await backend.organizations.organizations.set(organization.id, {
        ...rest,
        displayName: "Acme Renamed",
        updatedAt: new Date("2026-08-24T10:00:00.000Z"),
      });
      const read = await backend.organizations.organizations.get(
        organization.id,
      );
      expect(read?.displayName).toBe("Acme Renamed");
      expect(read?.ssoIssuer).toBeUndefined();
    });

    it("returns undefined for an unknown id or slug", async () => {
      expect(
        await backend.organizations.organizations.get("org_missing"),
      ).toBeUndefined();
      expect(
        await backend.organizations.organizations.getBySlug("no-such-slug"),
      ).toBeUndefined();
    });

    it("finds by slug and by creator", async () => {
      const createdBy = await principal();
      const first = await seedOrganization({ createdBy });
      const second = await seedOrganization({ createdBy });
      await seedOrganization();

      expect(
        (await backend.organizations.organizations.getBySlug(first.slug))?.id,
      ).toBe(first.id);
      const owned =
        await backend.organizations.organizations.listByCreator(createdBy);
      expect(owned.map((org) => org.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
    });

    it("findByIssuer matches either issuer column, trailing slash and all", async () => {
      const sso = `https://sso-${randomUUID().slice(0, 8)}.example`;
      const saml = `https://saml-${randomUUID().slice(0, 8)}.example`;
      const ssoOrg = await seedOrganization({ ssoIssuer: `${sso}/` });
      const samlOrg = await seedOrganization({ samlIssuer: saml });

      // Stored with a trailing slash, asked for without — and the reverse.
      expect(
        (await backend.organizations.organizations.findByIssuer(sso))?.id,
      ).toBe(ssoOrg.id);
      expect(
        (await backend.organizations.organizations.findByIssuer(`${sso}/`))?.id,
      ).toBe(ssoOrg.id);
      expect(
        (await backend.organizations.organizations.findByIssuer(`${saml}//`))
          ?.id,
      ).toBe(samlOrg.id);
      expect(
        await backend.organizations.organizations.findByIssuer(
          "https://nobody.example",
        ),
      ).toBeUndefined();
      // An empty issuer must not match the orgs that configured none.
      await seedOrganization();
      expect(
        await backend.organizations.organizations.findByIssuer(""),
      ).toBeUndefined();
    });
  });

  describe("organization membership store", () => {
    it("upserts, finds, lists, counts owners and removes", async () => {
      const organization = await seedOrganization();
      const owner = await principal();
      const member = await principal();
      const now = new Date("2026-08-24T09:00:00.000Z");

      await backend.organizations.organizationMemberships.upsert({
        organizationId: organization.id,
        principalId: owner,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      });
      await backend.organizations.organizationMemberships.upsert({
        organizationId: organization.id,
        principalId: member,
        role: "member",
        createdAt: now,
        updatedAt: now,
      });

      expect(
        await backend.organizations.organizationMemberships.find(
          organization.id,
          member,
        ),
      ).toEqual({
        organizationId: organization.id,
        principalId: member,
        role: "member",
        createdAt: now,
        updatedAt: now,
      });
      expect(
        await backend.organizations.organizationMemberships.find(
          organization.id,
          "prn_stranger",
        ),
      ).toBeUndefined();
      expect(
        await backend.organizations.organizationMemberships.listByOrganization(
          organization.id,
        ),
      ).toHaveLength(2);
      expect(
        await backend.organizations.organizationMemberships.listByPrincipal(
          owner,
        ),
      ).toHaveLength(1);
      expect(
        await backend.organizations.organizationMemberships.countOwners(
          organization.id,
        ),
      ).toBe(1);

      // A role change is the same upsert, not a second row.
      await backend.organizations.organizationMemberships.upsert({
        organizationId: organization.id,
        principalId: member,
        role: "owner",
        createdAt: now,
        updatedAt: new Date("2026-08-24T11:00:00.000Z"),
      });
      expect(
        await backend.organizations.organizationMemberships.listByOrganization(
          organization.id,
        ),
      ).toHaveLength(2);
      expect(
        await backend.organizations.organizationMemberships.countOwners(
          organization.id,
        ),
      ).toBe(2);

      expect(
        await backend.organizations.organizationMemberships.remove(
          organization.id,
          member,
        ),
      ).toBe(true);
      expect(
        await backend.organizations.organizationMemberships.remove(
          organization.id,
          member,
        ),
      ).toBe(false);
      expect(
        await backend.organizations.organizationMemberships.countOwners(
          organization.id,
        ),
      ).toBe(1);
    });

    it("counts owners per organization, not globally", async () => {
      const first = await seedOrganization();
      const second = await seedOrganization();
      const owner = await principal();
      const now = new Date();
      for (const organizationId of [first.id, second.id]) {
        await backend.organizations.organizationMemberships.upsert({
          organizationId,
          principalId: owner,
          role: "owner",
          createdAt: now,
          updatedAt: now,
        });
      }
      expect(
        await backend.organizations.organizationMemberships.countOwners(
          first.id,
        ),
      ).toBe(1);
    });
  });

  describe("byo upstream repository", () => {
    it("normalizes the issuer on write and on lookup", async () => {
      const issuer = `https://byo-${randomUUID().slice(0, 8)}.example`;
      const created = await backend.repos.byoUpstreams.create(
        byoUpstream({ issuer: `${issuer}/` }),
      );
      expect(created.issuer).toBe(issuer);

      expect((await backend.repos.byoUpstreams.findByIssuer(issuer))?.id).toBe(
        created.id,
      );
      expect(
        (await backend.repos.byoUpstreams.findByIssuer(`${issuer}//`))?.id,
      ).toBe(created.id);
      expect(
        await backend.repos.byoUpstreams.findByIssuer(
          "https://unregistered.example",
        ),
      ).toBeNull();
    });

    it("refuses a second record for the same normalized issuer", async () => {
      const issuer = `https://byo-${randomUUID().slice(0, 8)}.example`;
      await backend.repos.byoUpstreams.create(byoUpstream({ issuer }));
      await expect(
        backend.repos.byoUpstreams.create(
          byoUpstream({ issuer: `${issuer}/` }),
        ),
      ).rejects.toThrow(/already registered/);
    });

    it("round-trips credentials, lastUsedAt and state", async () => {
      const record = await backend.repos.byoUpstreams.create(
        byoUpstream({
          clientId: "client-xyz",
          clientSecret: "shhh-not-a-digest",
          clientAuth: "client_secret_post",
          registrationSource: "dcr",
        }),
      );
      const read = await backend.repos.byoUpstreams.getById(record.id);
      expect(read).toEqual(record);
      // lastUsedAt is absent until a sign-in touches it — the field a
      // memory-only run would happily forget to persist.
      expect(read?.lastUsedAt).toBeUndefined();

      const at = new Date("2026-08-24T12:00:00.000Z");
      await backend.repos.byoUpstreams.touchLastUsed(record.id, at);
      expect(
        (await backend.repos.byoUpstreams.getById(record.id))?.lastUsedAt,
      ).toEqual(at);

      // Touching an unknown id is a no-op, not a throw.
      await backend.repos.byoUpstreams.touchLastUsed("byo_missing", at);
      expect(
        await backend.repos.byoUpstreams.getById("byo_missing"),
      ).toBeNull();
    });

    it("omits an absent client secret rather than reading back null", async () => {
      const record = await backend.repos.byoUpstreams.create(byoUpstream());
      const read = await backend.repos.byoUpstreams.getById(record.id);
      expect(Object.hasOwn(read ?? {}, "clientSecret")).toBe(false);
    });

    it("lists newest first and toggles state for the operator surface", async () => {
      const older = await backend.repos.byoUpstreams.create(
        byoUpstream({ createdAt: new Date("2026-08-01T00:00:00.000Z") }),
      );
      const newer = await backend.repos.byoUpstreams.create(
        byoUpstream({ createdAt: new Date("2026-08-02T00:00:00.000Z") }),
      );
      const listed = await backend.repos.byoUpstreams.list();
      const ids = listed.map((row) => row.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));

      expect(
        (await backend.repos.byoUpstreams.setState(older.id, "disabled"))
          ?.state,
      ).toBe("disabled");
      expect((await backend.repos.byoUpstreams.getById(older.id))?.state).toBe(
        "disabled",
      );
      expect(
        await backend.repos.byoUpstreams.setState("byo_missing", "disabled"),
      ).toBeNull();
    });
  });

  describe("saml pending store and replay cache", () => {
    it("take is single-use", async () => {
      const organization = await seedOrganization();
      const requestId = `_${randomUUID()}`;
      const createdAt = new Date();
      await backend.saml.pending.put({
        requestId,
        interactionUid: "uid-123",
        organizationId: organization.id,
        createdAt,
      });

      expect(await backend.saml.pending.take(requestId)).toEqual({
        interactionUid: "uid-123",
        organizationId: organization.id,
        createdAt,
      });
      // A second response quoting the same InResponseTo finds nothing.
      expect(await backend.saml.pending.take(requestId)).toBeNull();
      expect(await backend.saml.pending.take("_never-issued")).toBeNull();
    });

    it("refuses an assertion id the second time it is seen", async () => {
      const assertionId = `_assert_${randomUUID()}`;
      const expiresAt = new Date(Date.now() + 300_000);
      expect(await backend.saml.replay.seen(assertionId, expiresAt)).toBe(
        false,
      );
      expect(await backend.saml.replay.seen(assertionId, expiresAt)).toBe(true);
      expect(await backend.saml.replay.seen(assertionId, expiresAt)).toBe(true);
      // A different assertion is still admitted.
      expect(
        await backend.saml.replay.seen(`_assert_${randomUUID()}`, expiresAt),
      ).toBe(false);
    });

    it("forgets an assertion id once its validity window has passed", async () => {
      const assertionId = `_assert_${randomUUID()}`;
      expect(
        await backend.saml.replay.seen(
          assertionId,
          new Date(Date.now() - 1_000),
        ),
      ).toBe(false);
      expect(
        await backend.saml.replay.seen(
          assertionId,
          new Date(Date.now() + 300_000),
        ),
      ).toBe(false);
    });
  });

  describe("scim stores", () => {
    function scimUser(
      organizationId: string,
      overrides: Partial<ScimUserRecord> = {},
    ): ScimUserRecord {
      const now = new Date("2026-08-24T09:00:00.000Z");
      return {
        id: `scim_${randomUUID()}`,
        organizationId,
        userName: `user-${randomUUID().slice(0, 8)}@acme.example`,
        active: true,
        raw: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"] },
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
    }

    it("round-trips a user and scopes reads to the organization", async () => {
      const organization = await seedOrganization();
      const other = await seedOrganization();
      const user = await backend.scim.users.create(
        scimUser(organization.id, {
          externalId: "ext-1",
          displayName: "Ada Lovelace",
        }),
      );

      expect(
        await backend.scim.users.getById(organization.id, user.id),
      ).toEqual(user);
      expect(await backend.scim.users.getById(other.id, user.id)).toBeNull();
      expect(
        (
          await backend.scim.users.findByUserName(
            organization.id,
            user.userName,
          )
        )?.id,
      ).toBe(user.id);
      expect(
        await backend.scim.users.findByUserName(other.id, user.userName),
      ).toBeNull();
    });

    it("omits absent optional attributes instead of reading back null", async () => {
      const organization = await seedOrganization();
      const user = await backend.scim.users.create(scimUser(organization.id));
      const read = await backend.scim.users.getById(organization.id, user.id);
      expect(Object.hasOwn(read ?? {}, "externalId")).toBe(false);
      expect(Object.hasOwn(read ?? {}, "displayName")).toBe(false);
    });

    it("findBySubject prefers externalId over userName", async () => {
      const organization = await seedOrganization();
      const subject = `subject-${randomUUID().slice(0, 8)}`;
      // One row carries the subject as its userName, another as its
      // externalId. The IdP's own stable id wins; matching on userName would
      // let a renamed account impersonate a provisioned one.
      const byUserName = await backend.scim.users.create(
        scimUser(organization.id, { userName: subject }),
      );
      const byExternalId = await backend.scim.users.create(
        scimUser(organization.id, { externalId: subject }),
      );

      expect(
        (await backend.scim.users.findBySubject(organization.id, subject))?.id,
      ).toBe(byExternalId.id);

      // With no externalId match, userName is the documented fallback.
      const soloOrg = await seedOrganization();
      const solo = await backend.scim.users.create(
        scimUser(soloOrg.id, { userName: subject }),
      );
      expect(
        (await backend.scim.users.findBySubject(soloOrg.id, subject))?.id,
      ).toBe(solo.id);
      expect(byUserName.id).not.toBe(byExternalId.id);
      expect(
        await backend.scim.users.findBySubject(organization.id, "nobody"),
      ).toBeNull();
    });

    it("deactivation survives the round-trip", async () => {
      const organization = await seedOrganization();
      const user = await backend.scim.users.create(scimUser(organization.id));
      const updated = await backend.scim.users.update({
        ...user,
        active: false,
        updatedAt: new Date("2026-08-24T13:00:00.000Z"),
      });
      expect(updated.active).toBe(false);
      expect(
        (await backend.scim.users.findBySubject(organization.id, user.userName))
          ?.active,
      ).toBe(false);
      expect(
        await backend.scim.users.listByOrganization(organization.id),
      ).toHaveLength(1);
    });

    it("verifies only live tokens of the owning organization", async () => {
      const organization = await seedOrganization();
      const other = await seedOrganization();
      const hash = `hash-${randomUUID()}`;
      const { id } = await backend.scim.tokens.mint(organization.id, hash);

      expect(await backend.scim.tokens.verify(organization.id, hash)).toBe(
        true,
      );
      // Org-scoped: another tenant's bearer never authenticates here.
      expect(await backend.scim.tokens.verify(other.id, hash)).toBe(false);
      expect(
        await backend.scim.tokens.verify(organization.id, "hash-unknown"),
      ).toBe(false);

      expect(await backend.scim.tokens.revoke(other.id, id)).toBe(false);
      expect(await backend.scim.tokens.revoke(organization.id, id)).toBe(true);
      expect(await backend.scim.tokens.revoke(organization.id, id)).toBe(false);
      expect(await backend.scim.tokens.verify(organization.id, hash)).toBe(
        false,
      );

      const listed = await backend.scim.tokens.list(organization.id);
      expect(listed.map((row) => row.id)).toEqual([id]);
      expect(listed[0]?.revokedAt).toBeInstanceOf(Date);
      // The listing is the owner surface: it must never carry a hash.
      expect(Object.hasOwn(listed[0] ?? {}, "hash")).toBe(false);
      expect(Object.hasOwn(listed[0] ?? {}, "tokenHash")).toBe(false);
    });
  });

  describe("org email domains", () => {
    it("routes only verified domains and is unique across organizations", async () => {
      const organization = await seedOrganization();
      const rival = await seedOrganization();
      const domain = `acme-${randomUUID().slice(0, 8)}.example`;

      await backend.federation.emailDomains.claim({
        organizationId: organization.id,
        domain: domain.toUpperCase(),
        verificationToken: "tok-1",
      });
      // Lowercased on the way in, so the login-path lookup cannot miss.
      expect((await backend.federation.emailDomains.get(domain))?.domain).toBe(
        domain,
      );
      // Unverified claims route nothing: an unproven claim over a domain is
      // not authority over its employees.
      expect(
        await backend.federation.emailDomains.findVerified(domain),
      ).toBeNull();

      await expect(
        backend.federation.emailDomains.claim({
          organizationId: rival.id,
          domain,
          verificationToken: "tok-2",
        }),
      ).rejects.toBeInstanceOf(OrgEmailDomainConflictError);

      const at = new Date("2026-08-24T14:00:00.000Z");
      expect(
        (await backend.federation.emailDomains.markVerified(domain, at))
          ?.verifiedAt,
      ).toEqual(at);
      expect(
        (await backend.federation.emailDomains.findVerified(domain))
          ?.organizationId,
      ).toBe(organization.id);
      expect(
        await backend.federation.emailDomains.findVerified(
          `unknown-${randomUUID().slice(0, 8)}.example`,
        ),
      ).toBeNull();

      expect(
        await backend.federation.emailDomains.listByOrganization(
          organization.id,
        ),
      ).toHaveLength(1);
      expect(
        await backend.federation.emailDomains.remove(rival.id, domain),
      ).toBe(false);
      expect(
        await backend.federation.emailDomains.remove(organization.id, domain),
      ).toBe(true);
      expect(await backend.federation.emailDomains.get(domain)).toBeNull();
    });

    it("re-claiming your own domain resets the token and keeps one row", async () => {
      const organization = await seedOrganization();
      const domain = `acme-${randomUUID().slice(0, 8)}.example`;
      await backend.federation.emailDomains.claim({
        organizationId: organization.id,
        domain,
        verificationToken: "tok-1",
      });
      await backend.federation.emailDomains.claim({
        organizationId: organization.id,
        domain,
        verificationToken: "tok-2",
      });
      const rows = await backend.federation.emailDomains.listByOrganization(
        organization.id,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.verificationToken).toBe("tok-2");
    });
  });

  describe("org ldap config", () => {
    function ldapConfig(
      organizationId: string,
      overrides: Partial<OrgLdapConfig> = {},
    ): OrgLdapConfig {
      return {
        organizationId,
        url: "ldaps://directory.acme.example:636",
        bindMode: "search_bind",
        searchBaseDn: "ou=people,dc=acme,dc=com",
        searchFilter: "(uid={username})",
        serviceBindDn: "cn=svc,dc=acme,dc=com",
        serviceBindSecret: "svc-secret",
        subjectAttribute: "entryUUID",
        attributeMap: { email: "mail", name: "cn" },
        groupRoleMap: { "cn=admins,dc=acme,dc=com": "owner" },
        ...overrides,
      };
    }

    it("round-trips both bind modes and their optional halves", async () => {
      const organization = await seedOrganization();
      const stored = await backend.federation.ldapConfigs.put(
        ldapConfig(organization.id),
      );
      expect(await backend.federation.ldapConfigs.get(organization.id)).toEqual(
        stored,
      );

      const template = await seedOrganization();
      const bindTemplate = await backend.federation.ldapConfigs.put({
        organizationId: template.id,
        url: "ldap://directory.dev.example:389",
        bindMode: "bind_template",
        bindTemplate: "uid={username},ou=people,dc=acme,dc=com",
        subjectAttribute: "entryUUID",
        attributeMap: {},
        groupRoleMap: {},
      });
      const read = await backend.federation.ldapConfigs.get(template.id);
      expect(read).toEqual(bindTemplate);
      expect(Object.hasOwn(read ?? {}, "searchBaseDn")).toBe(false);
      expect(Object.hasOwn(read ?? {}, "serviceBindSecret")).toBe(false);
      expect(read?.attributeMap).toEqual({});
      expect(read?.groupRoleMap).toEqual({});
    });

    it("put replaces the row, and remove clears it", async () => {
      const organization = await seedOrganization();
      await backend.federation.ldapConfigs.put(ldapConfig(organization.id));
      await backend.federation.ldapConfigs.put(
        ldapConfig(organization.id, { subjectAttribute: "objectGUID" }),
      );
      expect(
        (await backend.federation.ldapConfigs.get(organization.id))
          ?.subjectAttribute,
      ).toBe("objectGUID");
      expect(
        (await backend.federation.ldapConfigs.list()).filter(
          (row) => row.organizationId === organization.id,
        ),
      ).toHaveLength(1);

      expect(await backend.federation.ldapConfigs.remove(organization.id)).toBe(
        true,
      );
      expect(await backend.federation.ldapConfigs.remove(organization.id)).toBe(
        false,
      );
      expect(
        await backend.federation.ldapConfigs.get(organization.id),
      ).toBeNull();
    });
  });

  describe("findVerifiedByEmail", () => {
    async function verifiedIdentity(
      principalId: string,
      email: string,
      overrides = {},
    ) {
      return backend.repos.externalIdentities.create(
        makeIdentity(principalId, {
          issuer: `https://idp-${randomUUID().slice(0, 8)}.example`,
          emailNormalized: email,
          emailVerified: true,
          assurance: "verified",
          ...overrides,
        }),
      );
    }

    it("returns the oldest owning principal when several rows match", async () => {
      const email = `ada-${randomUUID().slice(0, 8)}@example.test`;
      const older = await principal({
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      const newer = await principal({
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      });
      // Seeded newest-first so a store that just returns the first row loses.
      await verifiedIdentity(newer, email);
      const wanted = await verifiedIdentity(older, email);

      const found =
        await backend.repos.externalIdentities.findVerifiedByEmail(email);
      expect(found?.id).toBe(wanted.id);
      expect(found?.principalId).toBe(older);
    });

    it("breaks a same-age tie by principal id", async () => {
      const email = `tie-${randomUUID().slice(0, 8)}@example.test`;
      const createdAt = new Date("2026-02-02T00:00:00.000Z");
      const suffix = randomUUID().slice(0, 8);
      const low = await principal({ id: `prn_aaa_${suffix}`, createdAt });
      const high = await principal({ id: `prn_zzz_${suffix}`, createdAt });
      await verifiedIdentity(high, email);
      await verifiedIdentity(low, email);

      expect(
        (await backend.repos.externalIdentities.findVerifiedByEmail(email))
          ?.principalId,
      ).toBe(low);
    });

    it("ignores rows that are not verified", async () => {
      const email = `unverified-${randomUUID().slice(0, 8)}@example.test`;
      const owner = await principal();
      // Same email, but neither row may be a link target: one is only
      // self-asserted, the other carries an email the upstream did not vouch
      // for. Either would be an account-takeover path.
      await verifiedIdentity(owner, email, { assurance: "self_asserted" });
      await verifiedIdentity(owner, email, { emailVerified: false });

      expect(
        await backend.repos.externalIdentities.findVerifiedByEmail(email),
      ).toBeNull();
    });

    it("returns null when no identity carries the email", async () => {
      expect(
        await backend.repos.externalIdentities.findVerifiedByEmail(
          `nobody-${randomUUID().slice(0, 8)}@example.test`,
        ),
      ).toBeNull();
    });

    it("does not match a different address", async () => {
      const owner = await principal();
      const email = `only-${randomUUID().slice(0, 8)}@example.test`;
      await verifiedIdentity(owner, email);
      expect(
        await backend.repos.externalIdentities.findVerifiedByEmail(
          `other-${email}`,
        ),
      ).toBeNull();
    });
  });
});
