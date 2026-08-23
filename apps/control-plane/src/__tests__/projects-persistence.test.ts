import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { AUDIT_METADATA_ALLOWLIST, verifyAuditChain } from "@opensesame/audit";
import {
  type Database,
  PostgresRepositories,
  type ProjectStores,
  type Repositories,
  createPostgresProjectStores,
} from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { type AuditEvent, overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

const here = dirname(fileURLToPath(import.meta.url));

type App = ReturnType<typeof createControlPlane>["app"];
type Ctx = ReturnType<typeof createControlPlane>["ctx"];

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

function auth(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function linkIdentity(app: App, token: string, subject: string) {
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: { ...auth(token), "idempotency-key": `verify-${subject}` },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
}

/** Full audit trail, oldest first, as the chain was written. */
async function fullTrail(ctx: Ctx): Promise<AuditEvent[]> {
  const events = await ctx.repos.auditEvents.list({ limit: 1000 });
  return [...events].reverse();
}

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/**
 * A fully migrated in-process Postgres (PGlite) behind the production
 * repositories and project stores, injected into the control plane — the
 * route suites' Postgres counterpart to the default memory stores.
 */
async function pgControlPlane() {
  const client = new PGlite();
  await client.waitReady;
  cleanups.push(() => client.close());
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: join(here, "../../../../packages/database/drizzle"),
  });
  // SAFETY: drizzle(PGlite) is the same schema-typed Database as postgres-js;
  // the query-result HKT differs, so TypeScript requires the unknown step.
  const database: Database = overlapCast(db);
  const repos: Repositories = new PostgresRepositories(database);
  const projectStores: ProjectStores = createPostgresProjectStores(database);
  const plane = createControlPlane({
    config: testConfig(),
    repos,
    projectStores,
  });
  await plane.ctx.systemPrincipalReady;
  return { ...plane, database, repos, projectStores };
}

describe("first authenticated session ensures the personal project", () => {
  it("provisions on identity link, through the changelog into the hash chain", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const guest = await provisional(app);

    // The anonymous mint does not pre-provision: the personal project appears
    // with the first authenticated (verified) session.
    expect(
      await ctx.stores.projects.findPersonalByOwner(guest.principalId),
    ).toBeUndefined();

    await linkIdentity(app, guest.accessToken, "first-session-owner");

    const personal = await ctx.stores.projects.findPersonalByOwner(
      guest.principalId,
    );
    expect(personal).toBeDefined();
    expect(personal?.kind).toBe("personal");
    expect(
      (
        await ctx.stores.projectMemberships.find(
          overlapCast(personal).id,
          guest.principalId,
        )
      )?.role,
    ).toBe("owner");

    // The provisioning went through recordSecretChangelog into the chained
    // trail: exactly one event, value-free metadata, chain intact.
    const trail = await fullTrail(ctx);
    const ensured = trail.filter(
      (e) => e.eventType === "project.personal.ensured",
    );
    expect(ensured).toHaveLength(1);
    expect(ensured[0]?.projectId).toBe(personal?.id);
    expect(ensured[0]?.principalId).toBe(guest.principalId);
    expect(ensured[0]?.metadata).toEqual({
      action: "project.personal.ensure",
      slug: "personal",
    });
    expect(verifyAuditChain(trail).ok).toBe(true);

    // The explicit route then reports the project as already present.
    const ensure = await app.request("/v1/projects/personal/ensure", {
      method: "POST",
      headers: { ...auth(guest.accessToken), "idempotency-key": "hook-ensure" },
    });
    expect(ensure.status).toBe(200);
    expect(overlapCast(await ensure.json()).created).toBe(false);

    // A second identity link records nothing further.
    await linkIdentity(app, guest.accessToken, "first-session-owner-2");
    const again = (await fullTrail(ctx)).filter(
      (e) => e.eventType === "project.personal.ensured",
    );
    expect(again).toHaveLength(1);
  });
});

describe("membership mutations record through the audit chain", () => {
  it("keeps the hash chain intact and metadata allowlisted", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    await linkIdentity(app, owner.accessToken, "chain-owner");
    const member = await provisional(app);

    const created = await app.request("/v1/projects", {
      method: "POST",
      headers: { ...auth(owner.accessToken), "idempotency-key": "chain-prj" },
      body: JSON.stringify({ displayName: "Chained" }),
    });
    expect(created.status).toBe(201);
    const project = overlapCast(await created.json());

    const added = await app.request(`/v1/projects/${project.id}/members`, {
      method: "POST",
      headers: auth(owner.accessToken),
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });
    expect(added.status).toBe(201);

    const changed = await app.request(
      `/v1/projects/${project.id}/members/${member.principalId}`,
      {
        method: "PATCH",
        headers: auth(owner.accessToken),
        body: JSON.stringify({ role: "admin" }),
      },
    );
    expect(changed.status).toBe(200);

    const removed = await app.request(
      `/v1/projects/${project.id}/members/${member.principalId}`,
      { method: "DELETE", headers: auth(owner.accessToken) },
    );
    expect(removed.status).toBe(204);

    const trail = await fullTrail(ctx);
    for (const eventType of [
      "project.member_added",
      "project.member_role_changed",
      "project.member_removed",
    ]) {
      const event = trail.find((e) => e.eventType === eventType);
      expect(event, eventType).toBeDefined();
      expect(event?.projectId).toBe(project.id);
      // Metadata survives only through the allowlist — never values.
      for (const key of Object.keys(event?.metadata ?? {})) {
        expect(AUDIT_METADATA_ALLOWLIST.has(key)).toBe(true);
      }
    }
    expect(verifyAuditChain(trail).ok).toBe(true);
  });
});

describe("projects routes against the Postgres store implementation", () => {
  it("serves the same contracts backed by PGlite rows", async () => {
    const { app, projectStores } = await pgControlPlane();
    const owner = await provisional(app);
    await linkIdentity(app, owner.accessToken, "pg-owner");
    const member = await provisional(app);

    // Personal project was ensured at identity link; the route reports it.
    const ensure = await app.request("/v1/projects/personal/ensure", {
      method: "POST",
      headers: { ...auth(owner.accessToken), "idempotency-key": "pg-ensure" },
    });
    expect(ensure.status).toBe(200);
    const personal = overlapCast(await ensure.json());
    expect(personal.created).toBe(false);
    expect(personal.slug).toBe("personal");
    expect(personal.sealedStoreTombName).toBe("personal");

    // Create + list.
    const created = await app.request("/v1/projects", {
      method: "POST",
      headers: { ...auth(owner.accessToken), "idempotency-key": "pg-create" },
      body: JSON.stringify({ displayName: "Durable" }),
    });
    expect(created.status).toBe(201);
    const project = overlapCast(await created.json());
    expect(project.role).toBe("owner");

    const listed = await app.request("/v1/projects", {
      headers: auth(owner.accessToken),
    });
    const projects = overlapCast(await listed.json()).projects;
    expect(projects).toHaveLength(2);
    expect(projects[0].kind).toBe("personal");
    expect(projects[1].id).toBe(project.id);

    // Active project swap and fallback.
    const swapped = await app.request("/v1/projects/active", {
      method: "PUT",
      headers: auth(owner.accessToken),
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(swapped.status).toBe(200);
    expect(overlapCast(await swapped.json()).isFallback).toBe(false);

    // Membership lifecycle with the last-owner fence.
    const added = await app.request(`/v1/projects/${project.id}/members`, {
      method: "POST",
      headers: auth(owner.accessToken),
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });
    expect(added.status).toBe(201);

    const dupe = await app.request(`/v1/projects/${project.id}/members`, {
      method: "POST",
      headers: auth(owner.accessToken),
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });
    expect(dupe.status).toBe(409);

    const lastOwner = await app.request(
      `/v1/projects/${project.id}/members/${owner.principalId}`,
      {
        method: "PATCH",
        headers: auth(owner.accessToken),
        body: JSON.stringify({ role: "member" }),
      },
    );
    expect(lastOwner.status).toBe(409);
    expect(overlapCast(await lastOwner.json()).error).toBe("last_owner");

    const roleChange = await app.request(
      `/v1/projects/${project.id}/members/${member.principalId}`,
      {
        method: "PATCH",
        headers: auth(owner.accessToken),
        body: JSON.stringify({ role: "admin" }),
      },
    );
    expect(roleChange.status).toBe(200);
    expect(overlapCast(await roleChange.json()).role).toBe("admin");

    const removed = await app.request(
      `/v1/projects/${project.id}/members/${member.principalId}`,
      { method: "DELETE", headers: auth(owner.accessToken) },
    );
    expect(removed.status).toBe(204);

    // Personal project cannot be deleted; standard can.
    const denied = await app.request(`/v1/projects/${personal.id}`, {
      method: "DELETE",
      headers: auth(owner.accessToken),
    });
    expect(denied.status).toBe(409);

    const deleted = await app.request(`/v1/projects/${project.id}`, {
      method: "DELETE",
      headers: auth(owner.accessToken),
    });
    expect(deleted.status).toBe(204);
    const gone = await app.request(`/v1/projects/${project.id}`, {
      headers: auth(owner.accessToken),
    });
    expect(gone.status).toBe(404);

    // The rows are durable store rows, not process memory: the store reads
    // back the personal project directly from Postgres.
    expect(
      (await projectStores.projects.findPersonalByOwner(owner.principalId))?.id,
    ).toBe(personal.id);
  });
});
