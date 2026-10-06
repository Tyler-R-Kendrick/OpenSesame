import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { EventSealError, createEventSealer } from "../src/event-seal.js";
import { createPostgresOrgFederationStores } from "../src/org-federation-store.js";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
import { sealLegacySecrets } from "../src/repos/sealed-secrets-sweep.js";
import { withSealedSecrets } from "../src/repos/sealed-secrets.js";
import { sealLegacySessions } from "../src/repos/sealed-sessions-sweep.js";
import * as schema from "../src/schema/index.js";
import { openSecretText } from "../src/secret-seal.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
const sealer = createEventSealer(
  "durable test key for migrating customer secrets",
);
beforeAll(async () => {
  ctx = await createPgTestContext();
});
afterAll(async () => {
  await ctx.client.close();
});

it("migrates every reversible domain secret and remains idempotent", async () => {
  const principal = await ctx.repos.principals.create(makePrincipal());
  const orgId = "migration-org";
  const now = new Date();
  await createPostgresOrganizationStores(ctx.db).organizations.set(orgId, {
    id: orgId,
    slug: orgId,
    displayName: orgId,
    state: "active",
    createdBy: principal.id,
    createdAt: now,
    updatedAt: now,
    ssoClientSecret: "sso-sensitive",
  });
  await ctx.db.insert(schema.orgLdapConfig).values({
    organizationId: orgId,
    url: "ldaps://example.test",
    bindMode: "search_bind",
    serviceBindSecret: "ldap-sensitive",
    subjectAttribute: "uid",
    attributeMap: {},
    groupRoleMap: {},
  });
  await ctx.repos.byoUpstreams.create({
    id: "migration-byo",
    issuer: "https://issuer.test",
    label: "issuer",
    clientId: "client",
    clientSecret: "byo-sensitive",
    clientAuth: "client_secret_post",
    registrationSource: "manual",
    state: "active",
    createdAt: now,
  });
  await ctx.repos.webhookEndpoints.create({
    id: "migration-hook",
    principalId: principal.id,
    url: "https://example.test/hook",
    secret: "hook-sensitive",
    createdAt: now,
  });
  await ctx.repos.pushSubscriptions.create({
    id: "migration-push",
    principalId: principal.id,
    endpoint: "https://push.example.test/sensitive",
    authSecret: "push-sensitive",
    p256dhKey: "public",
    endpointDigest: "migration-digest",
    createdAt: now,
  });
  await ctx.db
    .insert(schema.betterAuthUsers)
    .values({ id: "ba-user", name: "A", email: "a@example.test" });
  await ctx.db.insert(schema.betterAuthAccounts).values({
    id: "ba-account",
    userId: "ba-user",
    providerId: "provider",
    accountId: "upstream-id",
    accessToken: "access-sensitive",
    refreshToken: "refresh-sensitive",
    idToken: "id-sensitive",
    password: "password-sensitive",
  });
  await ctx.db.insert(schema.betterAuthSessions).values({
    id: "ba-session",
    userId: "ba-user",
    token: "session-sensitive",
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(await sealLegacySecrets(ctx.db, sealer)).toBe(11);
  expect(await sealLegacySecrets(ctx.db, sealer)).toBe(0);
  await verifyDomainSecrets(orgId);
  await verifyIdentitySecrets();
  await verifyStrictRestartColumns();
});

async function verifyDomainSecrets(orgId: string) {
  const repos = withSealedSecrets(ctx.repos, sealer);
  expect(
    (await repos.byoUpstreams.getById("migration-byo"))?.clientSecret,
  ).toBe("byo-sensitive");
  expect((await repos.webhookEndpoints.getById("migration-hook"))?.secret).toBe(
    "hook-sensitive",
  );
  expect(
    (await repos.pushSubscriptions.getById("migration-push"))?.authSecret,
  ).toBe("push-sensitive");
  expect(
    (
      await createPostgresOrganizationStores(ctx.db, sealer).organizations.get(
        orgId,
      )
    )?.ssoClientSecret,
  ).toBe("sso-sensitive");
  expect(
    (
      await createPostgresOrgFederationStores(ctx.db, sealer).ldapConfigs.get(
        orgId,
      )
    )?.serviceBindSecret,
  ).toBe("ldap-sensitive");
  const [raw] = await ctx.db.select().from(schema.pushSubscriptions);
  expect(raw?.endpoint).not.toContain("sensitive");
  expect(raw?.authSecret).not.toContain("sensitive");
}

async function verifyIdentitySecrets() {
  const [account] = await ctx.db.select().from(schema.betterAuthAccounts);
  expect(account?.accessToken).not.toContain("access-sensitive");
  expect(
    openSecretText(
      sealer,
      JSON.stringify([
        "better_auth_accounts",
        "provider",
        "upstream-id",
        "refreshToken",
      ]),
      "ba-user",
      account?.refreshToken ?? "",
    ),
  ).toBe("refresh-sensitive");
  const [session] = await ctx.db.select().from(schema.betterAuthSessions);
  expect(session?.token).toBe(
    sealer.lookupToken("better_auth_sessions.token", "session-sensitive"),
  );
  expect(session?.sealedToken).not.toContain("session-sensitive");
  expect(
    openSecretText(
      sealer,
      JSON.stringify(["better_auth_sessions", session?.token, "token"]),
      "ba-user",
      session?.sealedToken ?? "",
    ),
  ).toBe("session-sensitive");
}

it("preserves a concurrent session ownership change during migration", async () => {
  await ctx.db.insert(schema.betterAuthUsers).values([
    { id: "owner-before", name: "Before", email: "before@example.test" },
    { id: "owner-after", name: "After", email: "after@example.test" },
  ]);
  await ctx.db.insert(schema.betterAuthSessions).values({
    id: "owner-race-session",
    userId: "owner-before",
    token: "owner-race-token",
    expiresAt: new Date(Date.now() + 60_000),
  });
  let rotation: Promise<void> | undefined;
  const migrating = {
    ...sealer,
    seal(
      purpose: string,
      value: import("@opensesame/os-domain").JsonObject,
      scope?: string,
    ) {
      rotation = ctx.db
        .update(schema.betterAuthSessions)
        .set({ userId: "owner-after" })
        .where(eq(schema.betterAuthSessions.id, "owner-race-session"))
        .then(() => undefined);
      return sealer.seal(purpose, value, scope);
    },
  };
  expect(await sealLegacySessions(ctx.db, migrating)).toBe(0);
  await rotation;
  expect(await sealLegacySessions(ctx.db, sealer)).toBe(1);
  const [session] = await ctx.db
    .select()
    .from(schema.betterAuthSessions)
    .where(eq(schema.betterAuthSessions.id, "owner-race-session"));
  if (!session?.sealedToken) throw new Error("Session envelope missing");
  const envelope = session.sealedToken;
  const purpose = JSON.stringify([
    "better_auth_sessions",
    session.token,
    "token",
  ]);
  expect(openSecretText(sealer, purpose, "owner-after", envelope)).toBe(
    "owner-race-token",
  );
  expect(() =>
    openSecretText(sealer, purpose, "owner-before", envelope),
  ).toThrow();
});

async function verifyStrictRestartColumns() {
  const fields = [
    { table: "organizations", column: "sso_client_secret", id: "id" },
    {
      table: "org_ldap_config",
      column: "service_bind_secret",
      id: "organization_id",
    },
    { table: "byo_upstreams", column: "client_secret", id: "id" },
    { table: "webhook_endpoints", column: "secret", id: "id" },
    { table: "push_subscriptions", column: "endpoint", id: "id" },
    { table: "push_subscriptions", column: "auth_secret", id: "id" },
    ...["access_token", "refresh_token", "id_token", "password"].map(
      (column) => ({ table: "better_auth_accounts", column, id: "id" }),
    ),
  ];
  for (const field of fields) {
    const table = sql.identifier(field.table);
    const column = sql.identifier(field.column);
    const id = sql.identifier(field.id);
    const [row] = await ctx.db
      .select({ id: sql<string>`${id}`, value: sql<string>`${column}` })
      .from(sql`${table}`)
      .limit(1);
    if (!row) throw new Error(`missing ${field.table} fixture`);
    const replacement = `legacy-replayed-${field.column}`;
    try {
      await ctx.db.execute(
        sql`update ${table} set ${column} = ${replacement} where ${id} = ${row.id}`,
      );
      await expect(
        sealLegacySecrets(ctx.db, sealer, false),
      ).rejects.toBeInstanceOf(EventSealError);
      const [unchanged] = await ctx.db
        .select({ value: sql<string>`${column}` })
        .from(sql`${table}`)
        .where(sql`${id} = ${row.id}`);
      expect(unchanged?.value).toBe(replacement);
    } finally {
      await ctx.db.execute(
        sql`update ${table} set ${column} = ${row.value} where ${id} = ${row.id}`,
      );
    }
    expect(await sealLegacySecrets(ctx.db, sealer, false)).toBe(0);
  }
}
