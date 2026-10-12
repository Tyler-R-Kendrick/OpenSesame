import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type App = ReturnType<typeof createControlPlane>["app"];

async function principal(app: App, subject: string | null) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  const created = overlapCast(await res.json());
  const headers = {
    authorization: `Bearer ${created.accessToken}`,
    "content-type": "application/json",
  };
  if (subject) {
    const linked = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: { ...headers, "idempotency-key": `verify-${subject}` },
      body: JSON.stringify({
        kind: "oidc",
        issuer: "https://mock.example",
        subject,
        assurance: "verified",
      }),
    });
    expect(linked.status).toBe(201);
  }
  return { id: String(created.principalId), headers };
}

function setup() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  });
}

async function seeded(app: App) {
  const owner = await principal(app, "owner-sub");
  const peer = await principal(app, "peer-sub");
  const guest = await principal(app, null);
  const stranger = await principal(app, "stranger-sub");
  const made = await app.request("/v1/projects", {
    method: "POST",
    headers: { ...owner.headers, "idempotency-key": "create-1" },
    body: JSON.stringify({ displayName: "Team vault", slug: "team-vault" }),
  });
  expect(made.status).toBe(201);
  const project = String(overlapCast(await made.json()).id);
  for (const [who, role] of [
    [peer, "member"],
    [guest, "member"],
  ] as const) {
    const added = await app.request(`/v1/projects/${project}/members`, {
      method: "POST",
      headers: owner.headers,
      body: JSON.stringify({ principalId: who.id, role }),
    });
    expect(added.status).toBe(201);
  }
  return { owner, peer, guest, stranger, project };
}

interface Caller {
  readonly headers: { authorization: string; "content-type": string };
}

type Body =
  | { principalId: string; confirm: string }
  | { organizationId: string; confirm: string }
  | { confirm: string };

function transfer(app: App, project: string, who: Caller, body: Body) {
  return app.request(`/v1/projects/${project}/transfer`, {
    method: "POST",
    headers: who.headers,
    body: JSON.stringify(body),
  });
}

describe("POST /v1/projects/:id/transfer", () => {
  it("hands ownership to a registered member and keeps the old owner as admin", async () => {
    const { app } = setup();
    const s = await seeded(app);
    const res = await transfer(app, s.project, s.owner, {
      principalId: s.peer.id,
      confirm: "team-vault",
    });
    expect(res.status).toBe(200);
    const body = overlapCast(await res.json());
    expect(body.ownerPrincipalId).toBe(s.peer.id);
    expect(body.role).toBe("admin");

    const members = overlapCast(
      await (
        await app.request(`/v1/projects/${s.project}/members`, {
          headers: s.peer.headers,
        })
      ).json(),
    );
    const rows: { principalId: string; role: string }[] = overlapCast(
      members.members,
    );
    const roles = new Map(rows.map((row) => [row.principalId, row.role]));
    expect(roles.get(s.peer.id)).toBe("owner");
    expect(roles.get(s.owner.id)).toBe("admin");

    // The previous owner is no longer an owner, so cannot transfer again.
    const again = await transfer(app, s.project, s.owner, {
      principalId: s.peer.id,
      confirm: "team-vault",
    });
    expect(again.status).toBe(403);
  });

  it("refuses a wrong confirmation, a stranger, a guest and yourself", async () => {
    const { app } = setup();
    const s = await seeded(app);
    const refused = async (body: Body, status: number, error: string) => {
      const res = await transfer(app, s.project, s.owner, body);
      expect(res.status).toBe(status);
      expect(overlapCast(await res.json()).error).toBe(error);
    };
    await refused(
      { principalId: s.peer.id, confirm: "nope" },
      400,
      "confirmation_mismatch",
    );
    await refused(
      { principalId: s.stranger.id, confirm: "team-vault" },
      409,
      "target_not_member",
    );
    await refused(
      { principalId: s.guest.id, confirm: "team-vault" },
      409,
      "principal_inactive",
    );
    await refused(
      { principalId: s.owner.id, confirm: "team-vault" },
      409,
      "already_owner",
    );
    await refused({ confirm: "team-vault" }, 400, "validation_error");
  });

  it("is owner-only and 404 for a stranger", async () => {
    const { app } = setup();
    const s = await seeded(app);
    const asMember = await transfer(app, s.project, s.peer, {
      principalId: s.peer.id,
      confirm: "team-vault",
    });
    expect(asMember.status).toBe(403);
    const asStranger = await transfer(app, s.project, s.stranger, {
      principalId: s.stranger.id,
      confirm: "team-vault",
    });
    expect(asStranger.status).toBe(404);
  });

  it("never moves the personal project", async () => {
    const { app } = setup();
    const s = await seeded(app);
    const ensured = await app.request("/v1/projects/personal/ensure", {
      method: "POST",
      headers: { ...s.owner.headers, "idempotency-key": "personal-1" },
      body: "{}",
    });
    const personal = String(overlapCast(await ensured.json()).id);
    const res = await transfer(app, personal, s.owner, {
      principalId: s.peer.id,
      confirm: "personal",
    });
    expect(res.status).toBe(409);
    expect(overlapCast(await res.json()).error).toBe(
      "personal_project_immutable",
    );
  });

  it("moves a project under an organization the caller owns, and refuses one they don't", async () => {
    const { app } = setup();
    const s = await seeded(app);
    const stray = await app.request(`/v1/projects/${s.project}/transfer`, {
      method: "POST",
      headers: s.owner.headers,
      body: JSON.stringify({
        organizationId: "org_missing",
        confirm: "team-vault",
      }),
    });
    expect(stray.status).toBe(404);
  });
});
