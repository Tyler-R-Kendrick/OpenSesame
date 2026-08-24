import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type App = ReturnType<typeof createControlPlane>["app"];
interface ProvisionalRequestHeaders {
  "x-correlation-id"?: string;
}

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

async function provisional(app: App, headers: ProvisionalRequestHeaders = {}) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
    headers,
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

async function linkIdentity(
  app: App,
  accessToken: string,
  body: JsonObject,
  key = `link-${Math.random()}`,
) {
  return app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}

describe("principals routes edge cases", () => {
  it("rate-limits provisional mints per client fingerprint", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const headers = { "user-agent": "rate-limit-probe" };
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request("/v1/principals/provisional", {
        method: "POST",
        headers,
      });
      expect(res.status).toBe(201);
    }
    const limited = await app.request("/v1/principals/provisional", {
      method: "POST",
      headers,
    });
    expect(limited.status).toBe(429);
    expect(overlapCast(await limited.json()).error).toBe("rate_limited");

    // A different fingerprint has its own budget.
    const other = await app.request("/v1/principals/provisional", {
      method: "POST",
      headers: { "user-agent": "someone-else" },
    });
    expect(other.status).toBe(201);
  });

  it("sweeps stale mint budgets as the window slides", async () => {
    let now = new Date("2026-08-08T10:00:00Z");
    const { app } = createControlPlane({
      config: testConfig(),
      clock: () => now,
    });
    const headers = { "user-agent": "sliding-window" };
    const mint = () =>
      app.request("/v1/principals/provisional", { method: "POST", headers });

    expect((await mint()).status).toBe(201);
    now = new Date(now.getTime() + 30_000);
    expect((await mint()).status).toBe(201);
    // t0 falls out of the window, t0+30s stays — a partial prune.
    now = new Date(now.getTime() + 31_000);
    expect((await mint()).status).toBe(201);
    // Everything lapses — the fingerprint entry itself is dropped.
    now = new Date(now.getTime() + 61_000);
    expect((await mint()).status).toBe(201);
  });

  it("sweeps expired provisional sessions on the next mint", async () => {
    let now = new Date("2026-08-08T10:00:00Z");
    const { app, ctx } = createControlPlane({
      config: { ...testConfig(), provisionalTtlMs: 60_000 },
      clock: () => now,
    });
    const first = await provisional(app);
    expect(ctx.stores.provisionalSessions.has(first.sessionId)).toBe(true);

    now = new Date(now.getTime() + 61_000);
    await provisional(app);

    // The lapsed session, its token, and its durable identity are gone.
    expect(ctx.stores.provisionalSessions.has(first.sessionId)).toBe(false);
    expect(ctx.stores.provisionalTokens.has(first.accessToken)).toBe(false);
    expect(await ctx.repos.principals.getById(first.principalId)).toBeNull();

    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${first.accessToken}` },
    });
    expect(me.status).toBe(401);
  });

  it("revokes a bearer-authenticated session server-side", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };

    const revoked = await app.request("/v1/principals/provisional/revoke", {
      method: "POST",
      headers: auth,
    });
    expect(revoked.status).toBe(204);

    expect(
      (await app.request("/v1/principals/me", { headers: auth })).status,
    ).toBe(401);
  });

  it("refuses cookie-only revoke without an allowed origin", async () => {
    const { app, config } = createControlPlane({ config: testConfig() });
    const created = await provisional(app);
    const cookie = `${config.provisionalCookieName}=${created.accessToken}`;

    const noOrigin = await app.request("/v1/principals/provisional/revoke", {
      method: "POST",
      headers: { cookie },
    });
    expect(noOrigin.status).toBe(403);

    const withOrigin = await app.request("/v1/principals/provisional/revoke", {
      method: "POST",
      headers: { cookie, origin: "http://127.0.0.1:8788" },
    });
    expect(withOrigin.status).toBe(204);
    expect(withOrigin.headers.get("set-cookie")).toContain(
      `${config.provisionalCookieName}=`,
    );

    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(me.status).toBe(401);
  });

  it("revokes both sessions when bearer and cookie disagree", async () => {
    const { app, config } = createControlPlane({ config: testConfig() });
    const bearer = await provisional(app);
    const cookieSession = await provisional(app);

    const res = await app.request("/v1/principals/provisional/revoke", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer.accessToken}`,
        cookie: `${config.provisionalCookieName}=${cookieSession.accessToken}`,
        origin: "http://127.0.0.1:8788",
      },
    });
    expect(res.status).toBe(204);

    for (const token of [bearer.accessToken, cookieSession.accessToken]) {
      const me = await app.request("/v1/principals/me", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.status).toBe(401);
    }
  });

  it("answers 404 for /me when the principal record is gone", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const created = await provisional(app);
    expect(
      await ctx.repos.principals.deleteUnlinkedProvisional(created.principalId),
    ).toBe(true);

    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(me.status).toBe(404);
  });

  it("accepts prn_ bearer tokens only when explicitly enabled", async () => {
    const { app } = createControlPlane({
      config: { ...testConfig(), allowPrincipalBearer: true },
    });
    const created = await provisional(app);

    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.principalId}` },
    });
    expect(me.status).toBe(200);

    // An unknown principal id falls through to anonymous.
    const unknown = await app.request("/v1/principals/me", {
      headers: {
        authorization: "Bearer prn_00000000-0000-0000-0000-000000000000",
      },
    });
    expect(unknown.status).toBe(401);
  });

  it("rejects link-identities for unknown, suspended, or dev-gated principals", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };

    const invalid = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ kind: "oidc" }),
    });
    expect(invalid.status).toBe(400);

    // Suspended principals cannot gain new identities.
    const current = await ctx.repos.principals.getById(created.principalId);
    if (!current) throw new Error("principal missing");
    await ctx.repos.principals.update(
      created.principalId,
      { state: "suspended" },
      current.version,
    );
    const suspended = await linkIdentity(app, created.accessToken, {
      kind: "oidc",
      issuer: "https://mock.example",
      subject: "suspended-sub",
      assurance: "verified",
    });
    expect(suspended.status).toBe(403);
    expect(overlapCast(await suspended.json()).error).toBe(
      "principal_inactive",
    );

    // A principal record that vanished mid-request is a 404.
    const ghost = await provisional(app);
    expect(
      await ctx.repos.principals.deleteUnlinkedProvisional(ghost.principalId),
    ).toBe(true);
    const missing = await linkIdentity(app, ghost.accessToken, {
      kind: "oidc",
      issuer: "https://mock.example",
      subject: "ghost-sub",
      assurance: "verified",
    });
    expect(missing.status).toBe(404);
  });

  it("refuses self-asserted identity links when dev defaults are off", async () => {
    const { app } = createControlPlane({
      config: {
        ...testConfig(),
        allowDevDefaults: false,
        claimPepper: "prod-claim-pepper-for-test-only",
        isProduction: false,
      },
      processEnv: {
        ...process.env,
        OPENSESAME_ALLOW_DEV_DEFAULTS: "false",
        OPENSESAME_CLAIM_PEPPER: "prod-claim-pepper-for-test-only",
        NODE_ENV: "development",
      },
    });
    const created = await provisional(app);
    const res = await linkIdentity(app, created.accessToken, {
      kind: "oidc",
      issuer: "https://mock.example",
      subject: "dev-gated-sub",
      assurance: "verified",
    });
    expect(res.status).toBe(403);
    expect(overlapCast(await res.json()).error).toBe(
      "identity_link_requires_upstream",
    );
  });

  it("re-linking the same identity to the same principal is idempotent", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const created = await provisional(app);
    const link = {
      kind: "oidc",
      issuer: "https://mock.example",
      subject: "relink-sub",
      assurance: "verified",
    };

    const first = await linkIdentity(
      app,
      created.accessToken,
      link,
      "relink-1",
    );
    expect(first.status).toBe(201);

    const again = await linkIdentity(
      app,
      created.accessToken,
      link,
      "relink-2",
    );
    expect(again.status).toBe(200);
    const body = overlapCast(await again.json());
    expect(body.identity.subject).toBe("relink-sub");
  });

  it("unlinks only the caller's own identities", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const a = await provisional(app);
    const b = await provisional(app);

    const linked = await linkIdentity(
      app,
      a.accessToken,
      {
        kind: "oidc",
        issuer: "https://mock.example",
        subject: "unlink-sub",
        assurance: "verified",
      },
      "unlink-1",
    );
    expect(linked.status).toBe(201);
    const { identity } = overlapCast(await linked.json());

    // Unknown ids and other principals' ids both answer 404.
    const unknown = await app.request("/v1/principals/identities/xid_missing", {
      method: "DELETE",
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(unknown.status).toBe(404);

    const foreign = await app.request(
      `/v1/principals/identities/${identity.id}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${b.accessToken}` },
      },
    );
    expect(foreign.status).toBe(404);

    const removed = await app.request(
      `/v1/principals/identities/${identity.id}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${a.accessToken}` },
      },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true, id: identity.id });

    const again = await app.request(
      `/v1/principals/identities/${identity.id}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${a.accessToken}` },
      },
    );
    expect(again.status).toBe(404);
  });

  it("mapping resolve is disabled without a configured token", async () => {
    const { app } = createControlPlane({
      config: { ...testConfig(), mappingResolveToken: "" },
    });
    const res = await app.request(
      "/v1/principals/mapping/resolve?issuer=https%3A%2F%2Fmock.example&subject=sub",
    );
    expect(res.status).toBe(503);
  });

  it("mapping resolve requires the service token and issuer+subject", async () => {
    const { app } = createControlPlane({
      config: { ...testConfig(), mappingResolveToken: "mapping-test-token" },
    });
    const url =
      "/v1/principals/mapping/resolve?issuer=https%3A%2F%2Fmock.example&subject=sub";

    expect((await app.request(url)).status).toBe(401);
    expect(
      (
        await app.request(url, {
          headers: { authorization: "Bearer wrong-token" },
        })
      ).status,
    ).toBe(401);

    // The header alternative authenticates too.
    const missing = await app.request(
      "/v1/principals/mapping/resolve?issuer=https%3A%2F%2Fmock.example",
      { headers: { "x-opensesame-mapping-token": "mapping-test-token" } },
    );
    expect(missing.status).toBe(400);
    expect(overlapCast(await missing.json()).error).toBe("validation_error");
  });

  it("mapping resolve finds upstream mappings and linked identities", async () => {
    const { app, ctx } = createControlPlane({
      config: { ...testConfig(), mappingResolveToken: "mapping-test-token" },
    });
    const auth = { authorization: "Bearer mapping-test-token" };

    // A mapping written by an upstream ceremony (not the dev link seam).
    await ctx.mappings.save({
      principalId: "prn_upstream",
      betterAuthUserId: "ba_upstream",
      upstreamProviderId: "https://idp.example",
      upstreamSubject: "upstream-sub",
      provisional: false,
      createdAt: new Date(),
    });
    const fromMapping = await app.request(
      "/v1/principals/mapping/resolve?issuer=https%3A%2F%2Fidp.example&subject=upstream-sub",
      { headers: auth },
    );
    expect(fromMapping.status).toBe(200);
    expect(await fromMapping.json()).toMatchObject({
      principalId: "prn_upstream",
      provisional: false,
      assurance: "verified",
    });

    // A linked external identity resolves through the repository fallback.
    const owner = await provisional(app);
    const linked = await linkIdentity(app, owner.accessToken, {
      kind: "oidc",
      issuer: "https://repo.example",
      subject: "repo-sub",
      assurance: "verified",
    });
    expect(linked.status).toBe(201);

    const fromRepo = await app.request(
      "/v1/principals/mapping/resolve?issuer=https%3A%2F%2Frepo.example&subject=repo-sub",
      { headers: auth },
    );
    expect(fromRepo.status).toBe(200);
    expect(await fromRepo.json()).toMatchObject({
      principalId: owner.principalId,
      provisional: false,
      assurance: "verified",
    });

    // A non-oidc kind is honored: the oidc identity must not match it.
    const kindMiss = await app.request(
      "/v1/principals/mapping/resolve?issuer=https%3A%2F%2Frepo.example&subject=repo-sub&kind=nostr",
      { headers: auth },
    );
    expect(kindMiss.status).toBe(404);
  });

  it("carries a well-formed client correlation id into the audit trail", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const created = await provisional(app, {
      "x-correlation-id": "client-correlation-1",
    });

    const audit = await app.request("/v1/audit/events?limit=10", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    const events = overlapCast(await audit.json());
    const minted = events.events.find(
      (e) => e.eventType === "principal.provisional_created",
    );
    expect(minted?.correlationId).toBe("client-correlation-1");
  });
});
