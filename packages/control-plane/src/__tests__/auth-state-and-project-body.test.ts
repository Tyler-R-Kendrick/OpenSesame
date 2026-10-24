import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type App = ReturnType<typeof createControlPlane>["app"];

function config() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
    allowDevDefaults: true,
  } as const;
}

async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

function json(token: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

describe("live principal state on authenticated requests", () => {
  it("stops honouring a session as soon as its principal is suspended", async () => {
    const { app, ctx } = createControlPlane({ config: config() });
    const session = await provisional(app);
    const principal = await ctx.repos.principals.getById(session.principalId);
    if (!principal) throw new Error("principal missing");

    const before = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(before.status).toBe(200);

    await ctx.repos.principals.update(
      principal.id,
      { state: "suspended", updatedAt: ctx.clock() },
      principal.version,
    );

    const after = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    // Authentication itself is withdrawn, not merely one route's permission:
    // the middleware must not leave a suspended principal on the context.
    expect(after.status).toBe(401);
  });
});

describe("project body and slug fences", () => {
  it("reserves the personal slug for personal projects", async () => {
    const { app } = createControlPlane({ config: config() });
    const session = await provisional(app);
    const res = await app.request(
      "/v1/projects/temporary",
      json(session.accessToken, { name: "Impostor", slug: "personal" }),
    );
    expect(res.status).toBe(400);
    expect(overlapCast(await res.json()).error).toBe("validation_error");
  });

  it("refuses a non-object PATCH body instead of throwing", async () => {
    const { app } = createControlPlane({ config: config() });
    const session = await provisional(app);
    const created = await app.request(
      "/v1/projects",
      json(session.accessToken, { displayName: "Body Fence" }),
    );
    expect(created.status).toBe(201);
    const project = overlapCast(await created.json());

    const patched = await app.request(`/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "content-type": "application/json",
      },
      body: "null",
    });
    expect(patched.status).toBe(400);
    expect(overlapCast(await patched.json()).error).toBe("validation_error");
  });
});
