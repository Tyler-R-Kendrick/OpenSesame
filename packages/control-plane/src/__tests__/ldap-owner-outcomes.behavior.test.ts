import { randomBytes, randomUUID } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { directoryFixture, ldapRequest } from "./ldap-outcomes.test-support.js";
import { json, provisional, verified } from "./scim-test-helpers.js";

async function organizationFixture() {
  const plane = createControlPlane({
    processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
  });
  const owner = await verified(plane.app, randomUUID());
  const response = await plane.app.request("/v1/organizations", {
    method: "POST",
    headers: json(owner.accessToken),
    body: JSON.stringify({
      slug: `ldap-${randomUUID()}`,
      displayName: "LDAP outcomes",
    }),
  });
  expect(response.status).toBe(201);
  const org: { id: string } = overlapCast(await response.json());
  const path = `/v1/organizations/${org.id}/ldap`;
  return { ...plane, owner, org, path };
}

async function ownerConfigurationLifecycle() {
  const d = await directoryFixture();
  try {
    const f = await organizationFixture();
    const configured = await f.app.request(f.path, {
      method: "PUT",
      headers: json(f.owner.accessToken),
      body: JSON.stringify(ldapRequest(d)),
    });
    expect(configured.status).toBe(200);
    const body = await configured.json();
    expect(body).toMatchObject({
      organizationId: f.org.id,
      serviceBindConfigured: true,
      searchBaseDn: d.config.searchBaseDn,
      searchFilter: d.config.searchFilter,
      serviceBindDn: d.config.serviceBindDn,
      subjectAttribute: "entryUUID",
    });
    expect(body).not.toHaveProperty("serviceBindSecret");
    expect(JSON.stringify(body)).not.toContain(d.servicePassword);
    const before = structuredClone(
      await f.ctx.stores.orgFederation.ldapConfigs.get(f.org.id),
    );
    for (const input of [
      { ...ldapRequest(d), subjectAttribute: "entryUUID)(uid=*" },
      { ...ldapRequest(d), serviceBindSecret: undefined },
    ]) {
      expect(
        (
          await f.app.request(f.path, {
            method: "PUT",
            headers: json(f.owner.accessToken),
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(400);
      expect(
        await f.ctx.stores.orgFederation.ldapConfigs.get(f.org.id),
      ).toEqual(before);
    }
    const outsider = await provisional(f.app);
    expect(
      (
        await f.app.request(f.path, {
          method: "DELETE",
          headers: json(outsider.accessToken),
        })
      ).status,
    ).toBe(404);
    expect(await f.ctx.stores.orgFederation.ldapConfigs.get(f.org.id)).toEqual(
      before,
    );
    expect(
      (
        await f.app.request(f.path, {
          method: "DELETE",
          headers: json(f.owner.accessToken),
        })
      ).status,
    ).toBe(204);
    for (const [path, method] of [
      [f.path, "GET"],
      [f.path, "DELETE"],
      [`${f.path}/sync`, "POST"],
    ] as const) {
      expect(
        (
          await f.app.request(path, {
            method,
            headers: json(f.owner.accessToken),
          })
        ).status,
      ).toBe(404);
    }
    expect(d.server.bindAttempts()).toEqual([]);
    expect(
      JSON.stringify(await f.ctx.repos.auditEvents.list({ limit: 200 })),
    ).not.toContain(d.servicePassword);
  } finally {
    await d.server.close();
  }
}

async function realServiceBindFailure() {
  const d = await directoryFixture();
  try {
    const f = await organizationFixture();
    const wrong = randomBytes(24).toString("base64url");
    const configured = await f.app.request(f.path, {
      method: "PUT",
      headers: json(f.owner.accessToken),
      body: JSON.stringify({ ...ldapRequest(d), serviceBindSecret: wrong }),
    });
    expect(configured.status).toBe(200);
    const memberships = structuredClone(
      await f.ctx.stores.organizationMemberships.listByOrganization(f.org.id),
    );
    const failed = await f.app.request(`${f.path}/sync`, {
      method: "POST",
      headers: json(f.owner.accessToken),
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "directory_unavailable" });
    expect(
      await f.ctx.stores.organizationMemberships.listByOrganization(f.org.id),
    ).toEqual(memberships);
    const repaired = await f.app.request(f.path, {
      method: "PUT",
      headers: json(f.owner.accessToken),
      body: JSON.stringify(ldapRequest(d)),
    });
    expect(repaired.status).toBe(200);
    const synced = await f.app.request(`${f.path}/sync`, {
      method: "POST",
      headers: json(f.owner.accessToken),
    });
    expect(synced.status).toBe(200);
    expect(await synced.json()).toEqual({
      scanned: 1,
      joined: 0,
      deactivated: 0,
    });
    expect(
      await f.ctx.stores.organizationMemberships.listByOrganization(f.org.id),
    ).toEqual(memberships);
    expect(
      JSON.stringify(await f.ctx.repos.auditEvents.list({ limit: 200 })),
    ).not.toContain(wrong);
  } finally {
    await d.server.close();
  }
}

describe("Owner LDAP configuration and directory failures", () => {
  it(
    "keeps service credentials write-only, preserves valid state on refusal and removes only for the owner",
    ownerConfigurationLifecycle,
  );
  it(
    "maps a real upstream bind refusal to a closed error and preserves memberships before successful retry",
    realServiceBindFailure,
  );
});
