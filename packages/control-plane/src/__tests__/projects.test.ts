import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

async function provisional(app: ReturnType<typeof createControlPlane>["app"]) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  const body = overlapCast(await res.json());
  return body;
}

async function verifiedPrincipal(
  app: ReturnType<typeof createControlPlane>["app"],
  subject: string,
) {
  const created = await provisional(app);
  const auth = { authorization: `Bearer ${created.accessToken}` };
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": `verify-${subject}`,
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return { ...created, auth };
}

describe("project personal ensure and CRUD", () => {
  it("ensures a personal project idempotently for provisional principals", async () => {
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const created = await provisional(app);
    const auth = {
      authorization: `Bearer ${created.accessToken}`,
      "content-type": "application/json",
    };

    const first = await app.request("/v1/projects/personal/ensure", {
      method: "POST",
      headers: { ...auth, "idempotency-key": "personal-ensure-1" },
      body: "{}",
    });
    expect(first.status).toBe(201);
    const firstBody = overlapCast(await first.json());
    expect(firstBody.slug).toBe("personal");
    expect(firstBody.state).toBe("active");
    expect(firstBody.sealedStoreTombName).toBe("personal");
    expect(firstBody.pagesVaultFolderId).toMatch(/^vault_folder_/);
    expect(firstBody.created).toBe(true);

    const second = await app.request("/v1/projects/personal/ensure", {
      method: "POST",
      headers: { ...auth, "idempotency-key": "personal-ensure-2" },
      body: "{}",
    });
    expect(second.status).toBe(200);
    const secondBody = overlapCast(await second.json());
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.created).toBe(false);

    const listed = await app.request("/v1/projects", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(listed.status).toBe(200);
    const listBody = overlapCast(await listed.json());
    expect(listBody.projects).toHaveLength(1);
    expect(listBody.projects[0]?.id).toBe(firstBody.id);

    expect(ctx.stores.projects.get(firstBody.id)?.ownerPrincipalId).toBe(
      created.principalId,
    );
  });

  it("lets provisional principals create a standard project without upgrading", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const created = await provisional(app);
    const allowed = await app.request("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": "proj-create-provisional",
      },
      body: JSON.stringify({
        slug: "demo-app",
        displayName: "Demo App",
      }),
    });
    expect(allowed.status).toBe(201);
    expect(await allowed.json()).toMatchObject({
      slug: "demo-app",
      displayName: "Demo App",
      kind: "standard",
      role: "owner",
    });
  });

  it("lets verified principals create, patch, list, and soft-delete projects", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const { auth } = await verifiedPrincipal(app, "proj-crud-user");

    const created = await app.request("/v1/projects", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": "proj-create-verified",
      },
      body: JSON.stringify({
        slug: "demo-app",
        displayName: "Demo App",
        sealedStoreTombName: "demo-tomb",
      }),
    });
    expect(created.status).toBe(201);
    const project = overlapCast(await created.json());
    expect(project.slug).toBe("demo-app");
    expect(project.sealedStoreTombName).toBe("demo-tomb");

    const patched = await app.request(`/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Demo App Renamed" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      id: project.id,
      displayName: "Demo App Renamed",
    });

    const got = await app.request(`/v1/projects/${project.id}`, {
      headers: auth,
    });
    expect(got.status).toBe(200);

    const deleted = await app.request(`/v1/projects/${project.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(deleted.status).toBe(204);
  });

  it("refuses deleting the personal project", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const { auth } = await verifiedPrincipal(app, "proj-personal-delete");
    const ensured = await app.request("/v1/projects/personal/ensure", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": "personal-ensure-delete",
      },
      body: "{}",
    });
    const personal = overlapCast(await ensured.json());
    const deleted = await app.request(`/v1/projects/${personal.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(deleted.status).toBe(409);
  });
});
