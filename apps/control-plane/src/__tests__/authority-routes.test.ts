import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

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

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("GA-I authority routes", () => {
  it("spawns a wasmtime workload identity and audits it", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const res = await app.request("/v1/authority/workloads/spawn", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        orchestratorKind: "agent_registration",
        orchestratorPrincipalId: "agent:orch-1",
        realmId: "realm:acme",
        taskId: "task:1",
        accessDomainId: "domain:prod",
        runtimeProfile: "wasmtime",
        authorityGeneration: 1,
        publicKeyJkt: "jkt-workload-aaaaaaaa",
        ordinal: 0,
      } satisfies JsonObject),
    });
    expect(res.status).toBe(201);
    const body = overlapCast(await res.json());
    expect(body.kind).toBe("workload_instance");
    expect(body.principalId).toContain("workload:task:1:");
    expect(body.binding.runtimeProfile).toBe("wasmtime");

    const events = await ctx.repos.auditEvents.list({ limit: 200 });
    expect(
      events.some((e) => e.eventType === "authority.workload.spawned"),
    ).toBe(true);
  });

  it("refuses unsupported native runtime without inventing a grant", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const res = await app.request("/v1/authority/workloads/spawn", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        orchestratorKind: "agent_registration",
        orchestratorPrincipalId: "agent:orch-1",
        realmId: "realm:acme",
        taskId: "task:1",
        accessDomainId: "domain:prod",
        runtimeProfile: "native",
        authorityGeneration: 1,
        publicKeyJkt: "jkt-workload-bbbbbbbb",
        ordinal: 0,
      }),
    });
    expect(res.status).toBe(400);
    expect(overlapCast(await res.json()).error).toBe("invariant_violation");
  });

  it("binds PoP enrollment for a device principal", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const res = await app.request("/v1/authority/enrollment/pop", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subjectKind: "device",
        principalId: "device:phone-1",
        publicKeyJkt: "jkt-device-cccccccc",
        authorityGeneration: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = overlapCast(await res.json());
    expect(body.subjectKind).toBe("device");
    expect(body.publicKeyJkt).toBe("jkt-device-cccccccc");
    const events = await ctx.repos.auditEvents.list({ limit: 200 });
    expect(events.some((e) => e.eventType === "authority.enrollment.pop")).toBe(
      true,
    );
  });
});
