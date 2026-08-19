import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  authenticatedPrincipalId,
  ensurePersonalOrganization,
  hostApiEndpoint,
} from "../routes/organizations.js";

type App = ReturnType<typeof createControlPlane>["app"];

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
  return (await res.json()) as { principalId: string; accessToken: string };
}

async function verified(app: App, subject: string) {
  const created = await provisional(app);
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return created;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createOrg(app: App, token: string, slug: string) {
  const res = await app.request("/v1/organizations", {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ slug, displayName: `Org ${slug}` }),
  });
  return res;
}

function mockHostFetch(impl: () => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("organization helpers", () => {
  it("authenticatedPrincipalId throws when the middleware contract broke", () => {
    expect(() => authenticatedPrincipalId(undefined)).toThrow(
      /invariant violated/,
    );
    expect(authenticatedPrincipalId("prn_1")).toBe("prn_1");
  });

  it("hostApiEndpoint rejects non-HTTP, credentialed, and invalid URLs", () => {
    expect(hostApiEndpoint("https://host.example", "api/v1/x")?.href).toBe(
      "https://host.example/api/v1/x",
    );
    expect(
      hostApiEndpoint("https://host.example/base", "/api/v1/x")?.href,
    ).toBe("https://host.example/base/api/v1/x");
    expect(hostApiEndpoint("ftp://host.example", "api/v1/x")).toBeUndefined();
    expect(
      hostApiEndpoint("https://user:pass@host.example", "api/v1/x"),
    ).toBeUndefined();
    expect(hostApiEndpoint("not a url", "api/v1/x")).toBeUndefined();
  });

  it("ensurePersonalOrganization is idempotent", () => {
    const { ctx } = createControlPlane({ config: testConfig() });
    const first = ensurePersonalOrganization(ctx, "prn_1");
    const second = ensurePersonalOrganization(ctx, "prn_1");
    expect(second.organizationId).toBe(first.organizationId);
    expect(ctx.stores.organizations.size).toBe(1);
  });
});

describe("organizations routes edge cases", () => {
  it("gates creation on assurance, validation, and slug uniqueness", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const anon = await provisional(app);

    const lowAssurance = await createOrg(app, anon.accessToken, "anon-org");
    expect(lowAssurance.status).toBe(403);
    expect(((await lowAssurance.json()) as { error: string }).error).toBe(
      "assurance_too_low",
    );

    const owner = await verified(app, "org-create-owner");
    const invalid = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "BAD SLUG", displayName: "Nope" }),
    });
    expect(invalid.status).toBe(400);

    expect((await createOrg(app, owner.accessToken, "acme")).status).toBe(201);
    const dupe = await createOrg(app, owner.accessToken, "acme");
    expect(dupe.status).toBe(409);
    expect(((await dupe.json()) as { error: string }).error).toBe("slug_taken");
  });

  it("reads hide deleted and foreign organizations", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-read-owner");
    const outsider = await verified(app, "org-read-outsider");

    const created = await createOrg(app, owner.accessToken, "readable");
    const org = (await created.json()) as { id: string };

    expect(
      (
        await app.request(`/v1/organizations/${org.id}`, {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/v1/organizations/${org.id}`, {
          headers: auth(outsider.accessToken),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/v1/organizations/org:missing", {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);

    // A deleted org disappears from reads and lists.
    const stored = ctx.stores.organizations.get(org.id);
    if (!stored) throw new Error("org missing");
    ctx.stores.organizations.set(org.id, { ...stored, state: "deleted" });
    expect(
      (
        await app.request(`/v1/organizations/${org.id}`, {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);
    const list = await app.request("/v1/organizations", {
      headers: auth(owner.accessToken),
    });
    const ids = (
      (await list.json()) as { organizations: Array<{ id: string }> }
    ).organizations.map((o) => o.id);
    expect(ids).not.toContain(org.id);
  });

  it("lists members only for owners", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-members-owner");
    const member = await provisional(app);
    const outsider = await provisional(app);

    const org = (await (
      await createOrg(app, owner.accessToken, "members-org")
    ).json()) as { id: string };

    expect(
      (
        await app.request(`/v1/organizations/${org.id}/members`, {
          headers: auth(outsider.accessToken),
        })
      ).status,
    ).toBe(404);

    const addMember = await app.request(`/v1/organizations/${org.id}/members`, {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });
    expect(addMember.status).toBe(201);

    const asMember = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(member.accessToken),
    });
    expect(asMember.status).toBe(403);
    expect(((await asMember.json()) as { error: string }).error).toBe(
      "owner_required",
    );

    const asOwner = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(owner.accessToken),
    });
    expect(asOwner.status).toBe(200);
    expect(
      ((await asOwner.json()) as { members: unknown[] }).members,
    ).toHaveLength(2);
  });

  it("fences member addition by role and principal state", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-add-owner");
    const member = await provisional(app);
    const third = await provisional(app);
    const outsider = await provisional(app);

    const org = (await (
      await createOrg(app, owner.accessToken, "add-org")
    ).json()) as { id: string };
    const add = (token: string, body: unknown) =>
      app.request(`/v1/organizations/${org.id}/members`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect(
      (
        await add(outsider.accessToken, {
          principalId: third.principalId,
          role: "member",
        })
      ).status,
    ).toBe(404);
    expect(
      (await add(owner.accessToken, { principalId: third.principalId })).status,
    ).toBe(400);
    expect(
      (
        await add(owner.accessToken, {
          principalId: "prn_missing",
          role: "member",
        })
      ).status,
    ).toBe(404);

    const suspendedRecord = await ctx.repos.principals.getById(
      third.principalId,
    );
    if (!suspendedRecord) throw new Error("principal missing");
    await ctx.repos.principals.update(
      third.principalId,
      { state: "suspended" },
      suspendedRecord.version,
    );
    const inactive = await add(owner.accessToken, {
      principalId: third.principalId,
      role: "member",
    });
    expect(inactive.status).toBe(409);
    expect(((await inactive.json()) as { error: string }).error).toBe(
      "principal_inactive",
    );

    expect(
      (
        await add(owner.accessToken, {
          principalId: member.principalId,
          role: "member",
        })
      ).status,
    ).toBe(201);
    const dupe = await add(owner.accessToken, {
      principalId: member.principalId,
      role: "member",
    });
    expect(dupe.status).toBe(409);
    expect(((await dupe.json()) as { error: string }).error).toBe(
      "membership_exists",
    );

    // A plain member cannot add anyone.
    expect(
      (
        await add(member.accessToken, {
          principalId: outsider.principalId,
          role: "member",
        })
      ).status,
    ).toBe(403);
  });

  it("changes roles only through the owner and rolls back when Host fails", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-role-owner");
    const member = await provisional(app);

    const org = (await (
      await createOrg(app, owner.accessToken, "role-org")
    ).json()) as { id: string };
    await app.request(`/v1/organizations/${org.id}/members`, {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });

    const change = (
      token: string,
      target: string,
      body: unknown,
      orgId = org.id,
    ) =>
      app.request(`/v1/organizations/${orgId}/members/${target}`, {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect(
      (
        await change(
          owner.accessToken,
          member.principalId,
          { role: "admin" },
          "org:missing",
        )
      ).status,
    ).toBe(404);
    expect(
      (await change(member.accessToken, member.principalId, { role: "admin" }))
        .status,
    ).toBe(403);
    expect(
      (await change(owner.accessToken, "prn_missing", { role: "admin" }))
        .status,
    ).toBe(404);
    expect(
      (await change(owner.accessToken, member.principalId, {})).status,
    ).toBe(400);

    // No-op change answers with the current membership without calling Host.
    const fetchSpy = mockHostFetch(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    const noop = await change(owner.accessToken, member.principalId, {
      role: "member",
    });
    expect(noop.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    // The last owner cannot be demoted.
    const lastOwner = await change(owner.accessToken, owner.principalId, {
      role: "member",
    });
    expect(lastOwner.status).toBe(409);
    expect(((await lastOwner.json()) as { error: string }).error).toBe(
      "last_owner",
    );

    // Host acknowledgement gates the change.
    const promoted = await change(owner.accessToken, member.principalId, {
      role: "admin",
    });
    expect(promoted.status).toBe(200);
    expect(((await promoted.json()) as { role: string }).role).toBe("admin");

    // Host failure restores the previous role.
    fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));
    const failed = await change(owner.accessToken, member.principalId, {
      role: "member",
    });
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toBe(
      "session_revocation_failed",
    );
    const members = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(owner.accessToken),
    });
    const rows = (
      (await members.json()) as {
        members: Array<{ principalId: string; role: string }>;
      }
    ).members;
    expect(rows.find((m) => m.principalId === member.principalId)?.role).toBe(
      "admin",
    );

    // An unreachable Host rolls back the same way.
    fetchSpy.mockRejectedValue(new Error("connection refused"));
    const unreachable = await change(owner.accessToken, member.principalId, {
      role: "member",
    });
    expect(unreachable.status).toBe(502);
  });

  it("removes members with owner and last-owner fences and Host rollback", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-remove-owner");
    const member = await provisional(app);
    const outsider = await provisional(app);

    const org = (await (
      await createOrg(app, owner.accessToken, "remove-org")
    ).json()) as { id: string };
    await app.request(`/v1/organizations/${org.id}/members`, {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });

    const remove = (token: string, target: string, orgId = org.id) =>
      app.request(`/v1/organizations/${orgId}/members/${target}`, {
        method: "DELETE",
        headers: auth(token),
      });

    expect(
      (await remove(owner.accessToken, member.principalId, "org:missing"))
        .status,
    ).toBe(404);
    expect(
      (await remove(outsider.accessToken, member.principalId)).status,
    ).toBe(404);
    expect((await remove(member.accessToken, owner.principalId)).status).toBe(
      403,
    );
    expect((await remove(owner.accessToken, "prn_missing")).status).toBe(404);

    const lastOwner = await remove(owner.accessToken, owner.principalId);
    expect(lastOwner.status).toBe(409);
    expect(((await lastOwner.json()) as { error: string }).error).toBe(
      "last_owner",
    );

    // Host failure keeps the membership in place.
    const fetchSpy = mockHostFetch(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );
    const failed = await remove(owner.accessToken, member.principalId);
    expect(failed.status).toBe(502);
    expect(
      (
        await app.request(`/v1/organizations/${org.id}/members`, {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(200);

    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    expect((await remove(owner.accessToken, member.principalId)).status).toBe(
      204,
    );
    const after = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(owner.accessToken),
    });
    expect(
      ((await after.json()) as { members: unknown[] }).members,
    ).toHaveLength(1);
  });
});

describe("device approve edge cases", () => {
  it("requires a configured operator token", async () => {
    const { app } = createControlPlane({
      config: { ...testConfig(), operatorToken: "" },
    });
    const created = await provisional(app);
    const res = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(created.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_code: "ABCD-EFGH" }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(
      "operator_token_unconfigured",
    );
  });

  it("requires a user_code in a JSON object body", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const created = await provisional(app);

    const notJson = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(created.accessToken),
        "content-type": "application/json",
      },
      body: "not json at all{",
    });
    expect(notJson.status).toBe(400);

    const missing = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(created.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_code: "   " }),
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });

  it("requires disambiguation when the principal holds several memberships", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "device-multi-org");
    // Personal workspace plus one created organization.
    expect((await createOrg(app, owner.accessToken, "second-org")).status).toBe(
      201,
    );

    const res = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_code: "ABCD-EFGH" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "organization_id_required",
    );
  });

  it("denies approval into organizations the caller cannot use", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "device-deny-owner");
    const other = await verified(app, "device-deny-other");
    const foreignOrg = (await (
      await createOrg(app, other.accessToken, "foreign-org")
    ).json()) as { id: string };

    // Not a member.
    const notMember = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_code: "ABCD-EFGH",
        organization_id: foreignOrg.id,
      }),
    });
    expect(notMember.status).toBe(403);
    expect(((await notMember.json()) as { error: string }).error).toBe(
      "organization_access_denied",
    );

    // A suspended organization denies even its owner.
    const stored = ctx.stores.organizations.get(foreignOrg.id);
    if (!stored) throw new Error("org missing");
    ctx.stores.organizations.set(foreignOrg.id, {
      ...stored,
      state: "suspended",
    });
    const suspendedOrg = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(other.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_code: "ABCD-EFGH",
        organization_id: foreignOrg.id,
      }),
    });
    expect(suspendedOrg.status).toBe(403);
  });

  it("maps Host failures to statuses and keeps the operator token server-side", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const approve = () =>
      app.request("/v1/device/approve", {
        method: "POST",
        headers: {
          ...auth(owner.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ user_code: "ABCD-EFGH" }),
      });

    const fetchSpy = mockHostFetch(() =>
      Promise.resolve(new Response("gone", { status: 404 })),
    );
    const notFound = await approve();
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as { error: string }).error).toBe(
      "host_approval_failed",
    );

    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    const badGateway = await approve();
    expect(badGateway.status).toBe(502);
    expect(((await badGateway.json()) as { error: string }).error).toBe(
      "host_approval_failed",
    );

    fetchSpy.mockRejectedValue(new Error("connection refused"));
    const unreachable = await approve();
    expect(unreachable.status).toBe(502);
    expect(((await unreachable.json()) as { error: string }).error).toBe(
      "host_api_unreachable",
    );

    // A non-JSON Host answer is passed through as text.
    fetchSpy.mockResolvedValue(new Response("approved-plain", { status: 200 }));
    const plain = await approve();
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as { body: unknown }).body).toBe(
      "approved-plain",
    );
  });

  it("fails closed when the Host API URL is not a plain HTTP(S) base", async () => {
    const { app } = createControlPlane({
      config: { ...testConfig(), hostApiUrl: "ftp://host.example" },
    });
    const owner = await provisional(app);
    const res = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_code: "ABCD-EFGH" }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_host_api_url",
    );
  });
});
