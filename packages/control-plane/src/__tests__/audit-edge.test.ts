import {
  type AuditEvent,
  JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

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
  return { authorization: `Bearer ${token}` };
}

async function listEvents(app: App, token: string, query = "") {
  const res = await app.request(`/v1/audit/events${query}`, {
    headers: auth(token),
  });
  expect(res.status).toBe(200);
  return overlapCast(await res.json()).events;
}

describe("audit events filtering", () => {
  it("filters by projectId and eventType", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);

    const created = await app.request("/v1/projects/temporary", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Audit Me", ttlSeconds: 600 }),
    });
    const project = overlapCast(await created.json());

    const byProject = await listEvents(
      app,
      owner.accessToken,
      `?projectId=${project.projectId}`,
    );
    expect(byProject.length).toBeGreaterThan(0);
    expect(byProject.every((e) => e.projectId === project.projectId)).toBe(
      true,
    );

    const byType = await listEvents(
      app,
      owner.accessToken,
      "?eventType=principal.provisional_created",
    );
    expect(byType.length).toBe(1);
    expect(byType[0]?.eventType).toBe("principal.provisional_created");

    const missingType = await listEvents(
      app,
      owner.accessToken,
      "?eventType=no.such_event",
    );
    expect(missingType).toEqual([]);
  });

  it("serves only changelog events in changelog scope", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);

    // Personal-project provisioning writes a changelog event.
    const ensured = await app.request("/v1/projects/personal/ensure", {
      method: "POST",
      headers: auth(owner.accessToken),
    });
    expect(ensured.status).toBe(201);

    for (const query of [
      "?changelog=1",
      "?changelog=true",
      "?scope=changelog",
    ]) {
      const events = await listEvents(app, owner.accessToken, query);
      expect(events.length).toBeGreaterThan(0);
      expect(
        events.every((e) => e.eventType === "project.personal.ensured"),
      ).toBe(true);
    }

    // A non-changelog event type in changelog scope is a caller error.
    const bad = await app.request(
      "/v1/audit/events?changelog=1&eventType=principal.provisional_created",
      { headers: auth(owner.accessToken) },
    );
    expect(bad.status).toBe(400);
    expect(overlapCast(await bad.json()).error).toBe(
      "event_type_not_changelog",
    );

    // A changelog event type narrows the changelog further.
    const narrowed = await listEvents(
      app,
      owner.accessToken,
      "?changelog=1&eventType=project.personal.ensured",
    );
    expect(narrowed.length).toBeGreaterThan(0);
  });

  it("clamps the limit parameter into range", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    await app.request("/v1/projects/personal/ensure", {
      method: "POST",
      headers: auth(owner.accessToken),
    });

    const unparsable = await listEvents(app, owner.accessToken, "?limit=abc");
    expect(unparsable.length).toBeGreaterThan(1);

    const negative = await listEvents(app, owner.accessToken, "?limit=-5");
    expect(negative).toHaveLength(1);

    const huge = await listEvents(app, owner.accessToken, "?limit=99999");
    expect(huge.length).toBeGreaterThan(1);
  });
});

describe("audit chain verification", () => {
  function stealList(ctx: Ctx, events: AuditEvent[]) {
    const original = ctx.repos.auditEvents.list;
    ctx.repos.auditEvents = {
      ...ctx.repos.auditEvents,
      list: async () => events,
    };
    return () => {
      ctx.repos.auditEvents = { ...ctx.repos.auditEvents, list: original };
    };
  }

  it("confirms an intact trail", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const res = await app.request("/v1/audit/events/verify", {
      headers: auth(owner.accessToken),
    });
    expect(res.status).toBe(200);
    const body = overlapCast(await res.json());
    expect(body.ok).toBe(true);
    expect(body.checked).toBeGreaterThan(0);
  });

  it("reports an altered event and names it when it is the caller's own", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);

    const stored = await ctx.repos.auditEvents.list({ limit: 200 });
    const own = stored.find((e) => e.principalId === owner.principalId);
    if (!own) throw new Error("expected an own audit event");
    const tampered = stored.map((e) =>
      e.id === own.id ? { ...e, metadata: { ...e.metadata, forged: true } } : e,
    );
    const restore = stealList(ctx, tampered);
    try {
      const res = await app.request("/v1/audit/events/verify", {
        headers: auth(owner.accessToken),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        ok: false,
        reason: "altered",
        eventId: own.id,
      });
    } finally {
      restore();
    }
  });

  it("reports a deletion as broken and withholds another principal's event id", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const victim = await provisional(app);
    const caller = await provisional(app);
    // A third event after the caller's mint, owned by the victim: dropping the
    // middle event makes the victim's event the one that no longer follows.
    const ensured = await app.request("/v1/projects/personal/ensure", {
      method: "POST",
      headers: auth(victim.accessToken),
    });
    expect(ensured.status).toBe(201);

    const stored = await ctx.repos.auditEvents.list({ limit: 200 });
    // Newest first: [victim-ensure, caller-mint, victim-mint].
    const middleIndex = stored.findIndex(
      (e) =>
        e.principalId === caller.principalId &&
        e.eventType === "principal.provisional_created",
    );
    if (middleIndex < 1) throw new Error("expected surrounding events");
    const failing = stored[middleIndex - 1];
    if (!failing) throw new Error("expected a failing successor");
    expect(failing.principalId).toBe(victim.principalId);
    const broken = stored.filter((_, i) => i !== middleIndex);

    const restore = stealList(ctx, broken);
    try {
      const res = await app.request("/v1/audit/events/verify", {
        headers: auth(caller.accessToken),
      });
      expect(res.status).toBe(409);
      const body = overlapCast(await res.json());
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("broken");
      // The gap belongs to the victim, so the caller is not told which event.
      expect(body.eventId).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("withholds the event id when the tampered event is not the caller's", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const other = await provisional(app);
    const caller = await provisional(app);

    const stored = await ctx.repos.auditEvents.list({ limit: 200 });
    const foreign = stored.find((e) => e.principalId === other.principalId);
    if (!foreign) throw new Error("expected a foreign audit event");
    const tampered = stored.map((e) =>
      e.id === foreign.id
        ? { ...e, metadata: { ...e.metadata, forged: true } }
        : e,
    );
    const restore = stealList(ctx, tampered);
    try {
      const res = await app.request("/v1/audit/events/verify", {
        headers: auth(caller.accessToken),
      });
      expect(res.status).toBe(409);
      const body = overlapCast(await res.json());
      expect(body.reason).toBe("altered");
      expect(body.eventId).toBeUndefined();
    } finally {
      restore();
    }
  });
});
