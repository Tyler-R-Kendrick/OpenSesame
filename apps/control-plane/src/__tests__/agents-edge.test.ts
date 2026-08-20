import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";

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
  return overlapCast(await res.json());
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

async function registerAgent(
  app: App,
  token: string,
  body: JsonObject,
) {
  return app.request("/v1/agents", {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("agents routes edge cases", () => {
  it("validates registration bodies", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const res = await registerAgent(app, owner.accessToken, {
      displayName: "no-key",
    });
    expect(res.status).toBe(400);
    expect((overlapCast(await res.json())).error).toBe(
      "validation_error",
    );
  });

  it("registers with full attestation metadata into the active project", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const res = await registerAgent(app, owner.accessToken, {
      displayName: "full-agent",
      provider: "openai",
      softwareIdentity: "npm:@example/agent@1.0.0",
      publicKeyJkt: "jkt-full-agent",
      runtimeProvider: "local",
      attestationDigest: "sha256:abc",
    });
    expect(res.status).toBe(201);
    const body = overlapCast(await res.json());
    expect(body.state).toBe("provisional");

    // The default project is the caller's personal one.
    const active = await app.request("/v1/projects/active", {
      headers: auth(owner.accessToken),
    });
    const personal = (overlapCast(await active.json()))
      .project;
    expect(body.projectId).toBe(personal.id);
  });

  it("honors an explicit usable project and hides unusable ones", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "agent-proj-owner");
    const other = await verified(app, "agent-proj-other");

    const created = await app.request("/v1/projects", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName: "Agent Home" }),
    });
    const project = overlapCast(await created.json());

    const intoProject = await registerAgent(app, owner.accessToken, {
      displayName: "scoped-agent",
      publicKeyJkt: "jkt-scoped-agent",
      projectId: project.id,
    });
    expect(intoProject.status).toBe(201);
    expect(
      (overlapCast(await intoProject.json())).projectId,
    ).toBe(project.id);

    // Unknown and foreign projects are both 404.
    expect(
      (
        await registerAgent(app, owner.accessToken, {
          displayName: "lost-agent",
          publicKeyJkt: "jkt-lost-agent",
          projectId: "prj_missing",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await registerAgent(app, other.accessToken, {
          displayName: "intruder-agent",
          publicKeyJkt: "jkt-intruder",
          projectId: project.id,
        })
      ).status,
    ).toBe(404);
  });

  it("caps provisional principals at two live agents", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);

    for (const name of ["one", "two"]) {
      const res = await registerAgent(app, owner.accessToken, {
        displayName: `agent-${name}`,
        publicKeyJkt: `jkt-quota-${name}`,
      });
      expect(res.status).toBe(201);
    }
    const third = await registerAgent(app, owner.accessToken, {
      displayName: "agent-three",
      publicKeyJkt: "jkt-quota-three",
    });
    expect(third.status).toBe(403);
    expect((overlapCast(await third.json())).reasons).toContain(
      "quota_agents",
    );
  });

  it("starts a fresh claim only for the agent's owner", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const other = await provisional(app);

    const registered = await registerAgent(app, owner.accessToken, {
      displayName: "claim-me",
      publicKeyJkt: "jkt-claim-me",
    });
    const agent = overlapCast(await registered.json());

    // Unknown and foreign agent ids are both 404 — no existence oracle.
    expect(
      (
        await app.request("/v1/agents/agt_missing/claim", {
          method: "POST",
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/v1/agents/${agent.agentId}/claim`, {
          method: "POST",
          headers: auth(other.accessToken),
        })
      ).status,
    ).toBe(404);

    const claim = await app.request(`/v1/agents/${agent.agentId}/claim`, {
      method: "POST",
      headers: auth(owner.accessToken),
    });
    expect(claim.status).toBe(201);
    const body = overlapCast(await claim.json());
    expect(body.agentId).toBe(agent.agentId);
    expect(body.claimToken.startsWith("osc_clm_")).toBe(true);
  });
});
