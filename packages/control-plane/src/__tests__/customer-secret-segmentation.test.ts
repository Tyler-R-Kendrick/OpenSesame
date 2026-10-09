import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  type Database,
  createDrizzle,
  createSqlClient,
} from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type Plane = ReturnType<typeof createControlPlane>;
interface Owner {
  principalId: string;
  accessToken: string;
}
function auth(owner: Owner) {
  return {
    authorization: `Bearer ${owner.accessToken}`,
    "content-type": "application/json",
  };
}
async function customer(plane: Plane, name: string) {
  const minted = await plane.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(minted.status).toBe(201);
  const owner: Owner = overlapCast(await minted.json());
  const linked = await plane.app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: auth(owner),
    body: JSON.stringify({
      kind: "oidc",
      issuer: "http://localhost:9090",
      subject: name,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  const created = await plane.app.request("/v1/organizations", {
    method: "POST",
    headers: auth(owner),
    body: JSON.stringify({ slug: name, displayName: name }),
  });
  expect(created.status).toBe(201);
  const organization: { id: string } = overlapCast(await created.json());
  const secret = `${name}-private-sso-secret`;
  const configured = await plane.app.request(
    `/v1/organizations/${organization.id}`,
    {
      method: "PATCH",
      headers: auth(owner),
      body: JSON.stringify({
        ssoIssuer: `https://${name}.example.test`,
        ssoClientId: name,
        ssoClientSecret: secret,
      }),
    },
  );
  expect(configured.status).toBe(200);
  expect(await configured.text()).not.toContain(secret);
  const hook = await plane.app.request("/v1/webhooks", {
    method: "POST",
    headers: { ...auth(owner), "idempotency-key": name },
    body: JSON.stringify({ url: `https://hooks.example.test/${name}` }),
  });
  expect(hook.status).toBe(201);
  const endpoint: { id: string; secret: string } = overlapCast(
    await hook.json(),
  );
  return { owner, organization, secret, endpoint };
}

interface TestDatabaseBackend {
  db: Database;
  close(): Promise<void>;
}

async function databaseBackend(): Promise<TestDatabaseBackend> {
  const migrationsFolder = new URL(
    "../../../../packages/database/drizzle",
    import.meta.url,
  ).pathname;
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const name = `customer_${randomUUID().replaceAll("-", "")}`;
    const admin = createSqlClient(databaseUrl);
    await admin.unsafe(`create database "${name}"`);
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    const { db, sql } = createDrizzle(url.toString());
    const close = async () => {
      await sql.end();
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    };
    try {
      await migratePostgres(db, { migrationsFolder });
    } catch (error) {
      await close();
      throw error;
    }
    return { db, close };
  }
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: overlapCast(db), close: () => client.close() };
}

it("separates customer secrets across public APIs and replica restarts under one deployment", async () => {
  const backend = await databaseBackend();
  try {
    const { db } = backend;
    const options = {
      database: overlapCast(db),
      processEnv: {
        ...process.env,
        OPENSESAME_CLAIM_PEPPER: "customer-integration-stable-claim-pepper",
        OPENSESAME_EVENT_KEY: "customer-integration-stable-event-sealing-root",
      },
    };
    const first = createControlPlane(options);
    await first.ctx.systemPrincipalReady;
    const alpha = await customer(first, "customer-alpha");
    const beta = await customer(first, "customer-beta");
    const second = createControlPlane(options);
    await second.ctx.systemPrincipalReady;
    const read = (owner: Owner, id: string) =>
      second.app.request(`/v1/organizations/${id}`, { headers: auth(owner) });
    expect((await read(alpha.owner, alpha.organization.id)).status).toBe(200);
    expect((await read(beta.owner, alpha.organization.id)).status).toBe(404);
    const listed = await second.app.request("/v1/webhooks", {
      headers: auth(beta.owner),
    });
    expect(listed.status).toBe(200);
    const listing = await listed.text();
    expect(listing).toContain(beta.endpoint.id);
    expect(listing).not.toContain(alpha.endpoint.id);
    expect(listing).not.toContain(beta.endpoint.secret);
    const organizations = await db.select().from(schema.organizations);
    const hooks = await db.select().from(schema.webhookEndpoints);
    const dump = JSON.stringify({ organizations, hooks });
    for (const secret of [
      alpha.secret,
      beta.secret,
      alpha.endpoint.secret,
      beta.endpoint.secret,
    ])
      expect(dump).not.toContain(secret);
    const alphaOrg = organizations.find(
      (row) => row.id === alpha.organization.id,
    );
    const alphaHook = hooks.find((row) => row.id === alpha.endpoint.id);
    if (!alphaOrg?.ssoClientSecret || !alphaHook)
      throw new Error("Missing customer ciphertext");
    await db
      .update(schema.organizations)
      .set({ ssoClientSecret: alphaOrg.ssoClientSecret })
      .where(eq(schema.organizations.id, beta.organization.id));
    const rejected = await read(beta.owner, beta.organization.id);
    expect(rejected.status).toBe(500);
    expect(await rejected.text()).not.toContain(alpha.secret);
    expect((await read(alpha.owner, alpha.organization.id)).status).toBe(200);
    await db
      .update(schema.webhookEndpoints)
      .set({ secret: alphaHook.secret })
      .where(eq(schema.webhookEndpoints.id, beta.endpoint.id));
    const rejectedHook = await second.app.request("/v1/webhooks", {
      headers: auth(beta.owner),
    });
    expect(rejectedHook.status).toBe(500);
    expect(await rejectedHook.text()).not.toContain(alpha.endpoint.secret);
    expect(
      (await second.app.request("/v1/webhooks", { headers: auth(alpha.owner) }))
        .status,
    ).toBe(200);
  } finally {
    await backend.close();
  }
}, 60_000);
