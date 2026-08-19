import { describe, expect, it } from "vitest";
import {
  type ControlPlaneConfig,
  assertListenHostAllowed,
  assertSecureConfig,
  listenHostIsLoopback,
  loadConfig,
} from "../config.js";
import { createControlPlane } from "../create-app.js";
import { sanitizeCorrelationId } from "../middleware/context.js";
import { startServer } from "../server.js";
import { bumpUsage, createAppStores, getUsage } from "../state.js";

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

function prodBase(): ControlPlaneConfig {
  return {
    host: "127.0.0.1",
    port: 8788,
    publicUrl: "https://id.example",
    issuer: "https://id.example",
    claimPepper: "unique-claim-pepper-not-dev",
    provisionalCookieName: "os_provisional",
    provisionalTtlMs: 86_400_000,
    logLevel: "info",
    allowPrincipalBearer: false,
    allowDevDefaults: false,
    bootstrapPersonalOrganization: false,
    isProduction: true,
    corsOrigins: ["https://app.example"],
    hostApiUrl: "https://host.example",
    operatorToken: "operator-secret",
    mappingResolveToken: "mapping-resolve-secret",
  };
}

describe("config hardening", () => {
  it("recognizes every loopback spelling and nothing else", () => {
    for (const host of [
      "127.0.0.1",
      "localhost",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
    ]) {
      expect(listenHostIsLoopback(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "192.168.1.1", "example.com"]) {
      expect(listenHostIsLoopback(host)).toBe(false);
    }
  });

  it("honors the daemon non-local override", () => {
    expect(() =>
      assertListenHostAllowed("0.0.0.0", {
        OPENSESAME_DAEMON_ALLOW_NONLOCAL: "1",
      }),
    ).not.toThrow();
  });

  it("rejects every insecure production combination", () => {
    expect(() =>
      assertSecureConfig({ ...prodBase(), allowPrincipalBearer: true }),
    ).toThrow(/allowPrincipalBearer/);
    expect(() =>
      assertSecureConfig({
        ...prodBase(),
        claimPepper: "dev-claim-pepper-change-me",
      }),
    ).toThrow(/development default/);
    expect(() =>
      assertSecureConfig({ ...prodBase(), allowDevDefaults: true }),
    ).toThrow(/allowDevDefaults/);
    expect(() =>
      assertSecureConfig({ ...prodBase(), operatorToken: "" }),
    ).toThrow(/OPERATOR_TOKEN/);
    expect(() =>
      assertSecureConfig({ ...prodBase(), mappingResolveToken: "" }),
    ).toThrow(/MAPPING_RESOLVE_TOKEN/);
  });

  it("fails closed when production runs with the default claim pepper", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        OPENSESAME_ENV: "production",
      }),
    ).toThrow(/CLAIM_PEPPER/);
  });

  it("leaves operator and mapping tokens empty in production unless set", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      OPENSESAME_ENV: "production",
      OPENSESAME_CLAIM_PEPPER: "unique-claim-pepper-not-dev",
    });
    expect(config.operatorToken).toBe("");
    expect(config.mappingResolveToken).toBe("");
  });

  it("picks up DATABASE_URL when present", () => {
    const config = loadConfig({
      OPENSESAME_ENV: "test",
      DATABASE_URL: "postgres://localhost:5432/opensesame",
    });
    expect(config.databaseUrl).toBe("postgres://localhost:5432/opensesame");
  });
});

describe("usage accounting", () => {
  it("counts only live, owned, unexpired resources", () => {
    const stores = createAppStores();
    const now = new Date("2026-08-08T10:00:00Z");
    const base = {
      slug: "p",
      displayName: "P",
      createdAt: now,
      updatedAt: now,
    };

    stores.projects.set("prj_personal", {
      ...base,
      id: "prj_personal",
      kind: "personal",
      state: "active",
      ownerPrincipalId: "prn_1",
    });
    stores.projects.set("prj_expired", {
      ...base,
      id: "prj_expired",
      kind: "temporary",
      state: "provisional",
      ownerPrincipalId: "prn_1",
      expiresAt: new Date("2026-08-08T09:00:00Z"),
    });
    stores.projects.set("prj_temp", {
      ...base,
      id: "prj_temp",
      kind: "temporary",
      state: "provisional",
      ownerPrincipalId: "prn_1",
      expiresAt: new Date("2026-08-08T11:00:00Z"),
    });
    stores.projects.set("prj_standard", {
      ...base,
      id: "prj_standard",
      kind: "standard",
      state: "active",
      ownerPrincipalId: "prn_1",
    });
    stores.projects.set("prj_deleted", {
      ...base,
      id: "prj_deleted",
      kind: "standard",
      state: "deleted",
      ownerPrincipalId: "prn_1",
    });
    stores.projects.set("prj_other", {
      ...base,
      id: "prj_other",
      kind: "standard",
      state: "active",
      ownerPrincipalId: "prn_2",
    });

    stores.agents.set("agt_live", {
      id: "agt_live",
      projectId: "prj_standard",
      ownerPrincipalId: "prn_1",
      displayName: "a",
      state: "claimed",
      createdAt: now,
    });
    stores.agents.set("agt_revoked", {
      id: "agt_revoked",
      projectId: "prj_standard",
      ownerPrincipalId: "prn_1",
      displayName: "b",
      state: "revoked",
      createdAt: now,
    });
    stores.agents.set("agt_other", {
      id: "agt_other",
      projectId: "prj_standard",
      ownerPrincipalId: "prn_2",
      displayName: "c",
      state: "claimed",
      createdAt: now,
    });

    stores.organizations.set("org_own", {
      id: "org_own",
      slug: "own",
      displayName: "Own",
      state: "active",
      createdBy: "prn_1",
      createdAt: now,
      updatedAt: now,
    });
    stores.organizations.set("org_deleted", {
      id: "org_deleted",
      slug: "del",
      displayName: "Del",
      state: "deleted",
      createdBy: "prn_1",
      createdAt: now,
      updatedAt: now,
    });
    stores.organizations.set("org_other", {
      id: "org_other",
      slug: "other",
      displayName: "Other",
      state: "active",
      createdBy: "prn_2",
      createdAt: now,
      updatedAt: now,
    });

    stores.oauthClients.set("cli_active", {
      id: "cli_active",
      ownerPrincipalId: "prn_1",
      admissionMode: "pre_registered",
      displayName: "c",
      redirectUris: [],
      sectorIdentifier: "https://a.example",
      grantTypes: [],
      responseTypes: [],
      tokenEndpointAuthMethod: "none",
      allowedScopes: [],
      allowedResources: [],
      state: "active",
      createdAt: now,
      updatedAt: now,
    });
    stores.oauthClients.set("cli_revoked", {
      id: "cli_revoked",
      ownerPrincipalId: "prn_1",
      admissionMode: "pre_registered",
      displayName: "r",
      redirectUris: [],
      sectorIdentifier: "https://r.example",
      grantTypes: [],
      responseTypes: [],
      tokenEndpointAuthMethod: "none",
      allowedScopes: [],
      allowedResources: [],
      state: "revoked",
      createdAt: now,
      updatedAt: now,
    });

    const usage = getUsage(stores, "prn_1", now);
    expect(usage).toEqual({
      temporaryProjects: 1,
      temporaryResources: 0,
      agents: 1,
      organizations: 1,
      oauthClients: 1,
      projects: 1,
      claims: 0,
    });
  });

  it("bumpUsage accumulates temporary resource spend", () => {
    const stores = createAppStores();
    bumpUsage(stores, "prn_1", { temporaryResources: 3 });
    bumpUsage(stores, "prn_1", { temporaryResources: 2 });
    expect(getUsage(stores, "prn_1").temporaryResources).toBe(5);
  });
});

describe("http surface", () => {
  it("answers readiness negatively before the app is ready", async () => {
    const { app } = createControlPlane({ config: testConfig(), ready: false });
    const res = await app.request("/v1/health/ready");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { status: string }).status).toBe("not_ready");
  });

  it("allows private-network requests when asked in preflight", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const res = await app.request("/v1/health/live", {
      headers: { "access-control-request-private-network": "true" },
    });
    expect(res.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
  });

  it("turns an unhandled throw into a correlated 500, not a stack trace", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const created = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const { accessToken } = (await created.json()) as { accessToken: string };

    // Malformed JSON makes c.req.json() throw inside the handler.
    const res = await app.request("/v1/claims", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "x-correlation-id": "corr-500",
      },
      body: "{not json",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: string;
      correlationId: string;
    };
    expect(body.error).toBe("internal_error");
    expect(body.correlationId).toBe("corr-500");
  });

  it("does not authenticate non-pst bearer tokens", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const res = await app.request("/v1/principals/me", {
      headers: { authorization: "Bearer opaque-token" },
    });
    expect(res.status).toBe(401);
  });

  it("sweeps expired idempotency records on the next keyed request", async () => {
    let now = new Date("2026-08-08T10:00:00Z");
    const { app, ctx } = createControlPlane({
      config: testConfig(),
      clock: () => now,
    });
    const created = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const { accessToken } = (await created.json()) as { accessToken: string };
    const ensure = (key: string) =>
      app.request("/v1/projects/personal/ensure", {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "idempotency-key": key,
        },
      });

    expect((await ensure("sweep-1")).status).toBe(201);
    expect(ctx.stores.idempotency.size).toBe(1);

    // Past the ten-minute TTL the next keyed request evicts the stale record.
    now = new Date(now.getTime() + 11 * 60_000);
    expect((await ensure("sweep-2")).status).toBe(200);
    const keys = [...ctx.stores.idempotency.keys()];
    expect(keys.some((k) => k.endsWith(":sweep-1"))).toBe(false);
    expect(keys.some((k) => k.endsWith(":sweep-2"))).toBe(true);
  });
});

describe("createControlPlane", () => {
  it("falls back to a localhost rpID when publicUrl is not a URL", () => {
    const { ctx } = createControlPlane({
      config: { ...testConfig(), publicUrl: "not a url" },
    });
    expect(ctx.config.publicUrl).toBe("not a url");
    // Construction succeeded: the passkey rp derivation degraded, not threw.
    expect(ctx.passkeys).toBeDefined();
  });
});

describe("sanitizeCorrelationId", () => {
  it("keeps well-formed ids and replaces hostile ones", () => {
    expect(sanitizeCorrelationId("abc-DEF_123.456")).toBe("abc-DEF_123.456");
    expect(sanitizeCorrelationId("with spaces")).not.toBe("with spaces");
    expect(sanitizeCorrelationId("x".repeat(129))).not.toBe("x".repeat(129));
    expect(sanitizeCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("startServer", () => {
  it("serves Hono routes and mounts the OIDC provider paths", async () => {
    const { server, port } = await startServer({ config: testConfig() });
    try {
      const health = await fetch(`http://127.0.0.1:${port}/v1/health/live`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      // OIDC protocol paths are handled by the provider, not Hono.
      const discovery = await fetch(
        `http://127.0.0.1:${port}/.well-known/openid-configuration`,
      );
      expect(discovery.status).toBe(200);
      const doc = (await discovery.json()) as { issuer: string };
      expect(doc.issuer).toContain("127.0.0.1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
