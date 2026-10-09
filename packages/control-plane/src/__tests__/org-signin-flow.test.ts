import { createHash, randomBytes } from "node:crypto";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { isString, overlapCast } from "@opensesame/os-domain";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createControlPlane } from "../create-app.js";
import type { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";

/**
 * Organization sign-in, end to end against the reference IdP.
 *
 * Every token in this file is minted by a real IdP over a real socket, with
 * real RS256 keys generated at its startup: the audience, the issued-at and
 * the subject are the ones a browser leg would actually present, which is the
 * only way the join fences below prove anything.
 */

type App = ReturnType<typeof createControlPlane>["app"];
type Started = Awaited<ReturnType<typeof startServer>>;

/** The dev Pages origin — a configured CORS origin, and therefore an accepted audience (T17). */
const PAGES_ORIGIN = "http://localhost:5180";
const FOREIGN_ORIGIN = "http://127.0.0.1:4999";

function testConfig(issuer: string) {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
    trustedUpstreamIssuers: [issuer],
  } as const;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
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
      ...auth(created.accessToken),
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

/**
 * Run the browser leg Pages runs: origin-profile client, PKCE S256, and an
 * `Origin` header the IdP checks byte-for-byte. The id_token that comes back
 * carries `aud = origin:<origin>` — which is exactly the claim the join route
 * now insists on.
 */
async function mintOrgIdToken(
  idp: ReferenceIdp,
  origin: string,
): Promise<string> {
  const clientId = `origin:${origin}`;
  const redirectUri = `${origin}/opensesame/callback`;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${idp.issuer}/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorize.searchParams.set("code_challenge_method", "S256");
  const redirected = await fetch(authorize, { redirect: "manual" });
  expect(redirected.status).toBe(302);
  const code =
    new URL(redirected.headers.get("location") ?? "").searchParams.get(
      "code",
    ) ?? "";

  const tokens = await fetch(`${idp.issuer}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  expect(tokens.status).toBe(200);
  const idToken = overlapCast(await tokens.json()).id_token;
  if (!isString(idToken)) throw new Error("no id_token minted");
  return idToken;
}

/** The pairwise subject `verifyOrgIdToken` will resolve out of that token. */
function subjectOf(idToken: string): string {
  const [, payload] = idToken.split(".");
  const claims = overlapCast(
    JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")),
  );
  const sub = claims.pairwise_sub ?? claims.sub;
  if (!isString(sub)) throw new Error("no subject in id_token");
  return sub;
}

async function seedTenant(app: App, idp: ReferenceIdp, slug: string) {
  const owner = await verified(app, `${slug}-owner`);
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: { ...auth(owner.accessToken), "content-type": "application/json" },
    body: JSON.stringify({
      slug,
      displayName: `Org ${slug}`,
      ssoIssuer: idp.issuer,
    }),
  });
  expect(created.status).toBe(201);
  return { owner, org: overlapCast(await created.json()) };
}

function join(app: App, slug: string, token: string, idToken: string) {
  return app.request(`/v1/organizations/tenants/${slug}/join`, {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ method: "sso", idToken }),
  });
}

describe("organization tenant join — hardened against the reference IdP", () => {
  let idp: ReferenceIdp;

  beforeAll(async () => {
    idp = await startReferenceIdp();
  }, 30_000);

  afterAll(async () => {
    await idp.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("binds the asserted subject to the caller and grants membership", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { org } = await seedTenant(app, idp, "acme");
    const guest = await provisional(app);
    const idToken = await mintOrgIdToken(idp, PAGES_ORIGIN);

    const joined = await join(app, "acme", guest.accessToken, idToken);
    expect(joined.status).toBe(201);
    expect(overlapCast(await joined.json()).role).toBe("member");

    // The subject is now the caller's identity — asserted from the store, not
    // inferred from the response.
    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind: "oidc",
      issuer: idp.issuer,
      subject: subjectOf(idToken),
    });
    expect(identity?.principalId).toBe(guest.principalId);
    expect(identity?.assurance).toBe("verified");

    const membership = await ctx.stores.organizationMemberships.find(
      org.id,
      guest.principalId,
    );
    expect(membership?.role).toBe("member");
  });

  it("refuses a token minted for an audience that is not one of ours", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { org } = await seedTenant(app, idp, "aud-org");
    const guest = await provisional(app);
    const idToken = await mintOrgIdToken(idp, FOREIGN_ORIGIN);

    const refused = await join(app, "aud-org", guest.accessToken, idToken);
    expect(refused.status).toBe(401);
    expect(overlapCast(await refused.json()).error).toBe("invalid_token");
    expect(
      await ctx.stores.organizationMemberships.find(org.id, guest.principalId),
    ).toBeUndefined();
  });

  it("refuses a token older than the ten-minute join window", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { org } = await seedTenant(app, idp, "stale-org");
    const guest = await provisional(app);
    // Minted now, presented later: the token stays inside its own one-hour
    // expiry, so only the max-age fence can refuse it.
    const idToken = await mintOrgIdToken(idp, PAGES_ORIGIN);

    // Only `Date` is faked: the JWKS fetch below is a real HTTP round-trip and
    // must keep its own timers.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 700_000));
    const refused = await join(app, "stale-org", guest.accessToken, idToken);
    vi.useRealTimers();

    expect(refused.status).toBe(401);
    expect(overlapCast(await refused.json()).error).toBe("invalid_token");
    expect(
      await ctx.stores.organizationMemberships.find(org.id, guest.principalId),
    ).toBeUndefined();
  });

  it("refuses an assertion whose subject already belongs to someone else", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { org } = await seedTenant(app, idp, "bound-org");
    const idToken = await mintOrgIdToken(idp, PAGES_ORIGIN);
    const subject = subjectOf(idToken);

    const incumbent = await provisional(app);
    const claimed = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        ...auth(incumbent.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "oidc",
        issuer: idp.issuer,
        subject,
        assurance: "verified",
      }),
    });
    expect(claimed.status).toBe(201);

    const impostor = await provisional(app);
    const refused = await join(app, "bound-org", impostor.accessToken, idToken);
    expect(refused.status).toBe(409);
    const body = overlapCast(await refused.json());
    expect(body.error).toBe("identity_collision");
    // The 409 must not name the principal that owns the identity
    // (federated-signin.md §7.6) — that would be an enumeration oracle.
    expect(JSON.stringify(body)).not.toContain(incumbent.principalId);
    expect(
      await ctx.stores.organizationMemberships.find(
        org.id,
        impostor.principalId,
      ),
    ).toBeUndefined();
  });

  it("refuses a native-SAML tenant an id_token join", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { org } = await seedTenant(app, idp, "saml-org");
    const stored = await ctx.stores.organizations.get(org.id);
    if (!stored) throw new Error("org missing");
    await ctx.stores.organizations.set(org.id, {
      ...stored,
      samlIssuer: idp.issuer,
      samlMetadataUrl: `${idp.issuer}/saml/metadata`,
    });

    const guest = await provisional(app);
    const refused = await app.request(
      "/v1/organizations/tenants/saml-org/join",
      {
        method: "POST",
        headers: {
          ...auth(guest.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "saml",
          idToken: await mintOrgIdToken(idp, PAGES_ORIGIN),
        }),
      },
    );
    expect(refused.status).toBe(409);
    expect(overlapCast(await refused.json()).error).toBe(
      "auth_method_unavailable",
    );
  });

  it("refuses a subject the tenant's directory has not provisioned", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { org } = await seedTenant(app, idp, "scim-org");
    const stored = await ctx.stores.organizations.get(org.id);
    if (!stored) throw new Error("org missing");
    await ctx.stores.organizations.set(org.id, {
      ...stored,
      provisioningEnabled: true,
    });

    const guest = await provisional(app);
    const idToken = await mintOrgIdToken(idp, PAGES_ORIGIN);
    const refused = await join(app, "scim-org", guest.accessToken, idToken);
    expect(refused.status).toBe(403);
    expect(overlapCast(await refused.json()).error).toBe("not_provisioned");

    const now = ctx.clock();
    await ctx.stores.scim.users.create({
      id: `scim_${randomBytes(8).toString("hex")}`,
      organizationId: org.id,
      externalId: subjectOf(idToken),
      userName: "joiner@acme.example",
      active: true,
      raw: {},
      createdAt: now,
      updatedAt: now,
    });
    const admitted = await join(app, "scim-org", guest.accessToken, idToken);
    expect(admitted.status).toBe(201);
  });

  /**
   * The role a directory pushed is the tenant's own answer about its own
   * people, so it has to survive the join that first creates the membership
   * (C15). Before this was wired, a subject the directory had put in the
   * owners group joined as `member` and stayed there until somebody noticed.
   */
  it("joins a provisioned subject at the role its directory assigned", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { org } = await seedTenant(app, idp, "role-org");
    const guest = await provisional(app);
    const idToken = await mintOrgIdToken(idp, PAGES_ORIGIN);

    const now = ctx.clock();
    await ctx.stores.scim.users.create({
      id: `scim_${randomBytes(8).toString("hex")}`,
      organizationId: org.id,
      externalId: subjectOf(idToken),
      userName: "lead@acme.example",
      active: true,
      // What a Groups PATCH stores when the configured owners group matches.
      raw: { "urn:opensesame:params:scim:2.0:role": "owner" },
      createdAt: now,
      updatedAt: now,
    });

    const joined = await join(app, "role-org", guest.accessToken, idToken);
    expect(joined.status).toBe(201);
    expect(overlapCast(await joined.json()).role).toBe("owner");
    const membership = await ctx.stores.organizationMemberships.find(
      org.id,
      guest.principalId,
    );
    expect(membership?.role).toBe("owner");
  });

  it("survives a store round-trip: an org is read back through the interface", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { org } = await seedTenant(app, idp, "durable-org");

    const bySlug = await ctx.stores.organizations.getBySlug("durable-org");
    expect(bySlug?.id).toBe(org.id);
    expect(bySlug?.ssoIssuer).toBe(idp.issuer);
    // The trust fence resolves the tenant by either issuer column, normalized.
    expect(
      (await ctx.stores.organizations.findByIssuer(`${idp.issuer}/`))?.id,
    ).toBe(org.id);
    expect(
      await ctx.stores.organizations.findByIssuer("https://nobody.example"),
    ).toBeUndefined();
  });
});

function extractCsrf(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match?.[1]) throw new Error("no csrf token in page");
  return match[1];
}

class Jar {
  private cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }

  header() {
    if (this.cookies.size === 0) return {};
    return {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
  }
}

describe("organization sign-in from the hosted login page", () => {
  const RP_ORIGIN = "http://127.0.0.1:4321";
  let idp: ReferenceIdp;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    idp = await startReferenceIdp();
    const { startServer: start } = await import("../server.js");
    started = await onFreePort((port) =>
      start({
        config: {
          host: "127.0.0.1",
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          issuer: `http://127.0.0.1:${port}`,
        },
        processEnv: {
          ...process.env,
          OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
          OPENSESAME_TRUSTED_UPSTREAMS: idp.issuer,
        },
      }),
    );
    base = `http://127.0.0.1:${started.port}`;

    const now = started.ctx.clock();
    await started.ctx.stores.organizations.set("org:hosted", {
      id: "org:hosted",
      slug: "hosted-acme",
      displayName: "Hosted Acme",
      state: "active",
      createdBy: "prn_seed",
      createdAt: now,
      updatedAt: now,
      ssoIssuer: idp.issuer,
    });
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await idp.close();
  });

  async function req(jar: Jar, path: string, init: RequestInit = {}) {
    const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
      redirect: "manual",
      ...init,
      headers: { ...jar.header(), ...overlapCast(init.headers) },
    });
    jar.absorb(res);
    return res;
  }

  async function loginPage() {
    const jar = new Jar();
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      client_id: `origin:${RP_ORIGIN}`,
      redirect_uri: `${RP_ORIGIN}/opensesame/callback`,
      response_type: "code",
      scope: "openid",
      state: "s-1",
      nonce: "n-1",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const res = await req(jar, `/auth?${params.toString()}`);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    const uid = location.slice("/interaction/".length);
    const page = await req(jar, location);
    return { jar, uid, html: await page.text() };
  }

  function postSlug(csrf: string, slug: string): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf, slug }),
    };
  }

  it("routes a known slug to a re-render carrying that tenant's methods", async () => {
    const { jar, uid, html } = await loginPage();
    const lookup = await req(
      jar,
      `/interaction/${uid}/federated/org`,
      postSlug(extractCsrf(html), "hosted-acme"),
    );
    expect(lookup.status).toBe(303);
    expect(lookup.headers.get("location")).toBe(
      `/interaction/${uid}?org=hosted-acme`,
    );

    const rendered = await req(jar, lookup.headers.get("location") ?? "");
    const page = await rendered.text();
    // That tenant's methods, and only that tenant's: the SSO button carries
    // the issuer this organization configured.
    expect(page).toContain("Continue with SSO");
    expect(page).toContain(`name="issuer" value="${idp.issuer}"`);
    expect(page).toContain('name="slug" value="hosted-acme"');
    // CSP on these pages has no script-src, so the flow is forms all the way.
    expect(page).not.toContain("<script");
  });

  it("answers an unknown slug uniformly, with a token the next submit can spend", async () => {
    const { jar, uid, html } = await loginPage();
    const missing = await req(
      jar,
      `/interaction/${uid}/federated/org`,
      postSlug(extractCsrf(html), "no-such-tenant"),
    );
    expect(missing.status).toBe(200);
    const page = await missing.text();
    expect(page).toContain(
      "No organization sign-in is configured for that name.",
    );
    expect(page).not.toContain("<script");

    // `csrf.verify` consumed the submitted token (T13); the re-render must
    // carry a fresh one or the visitor's next attempt 403s.
    const retry = await req(
      jar,
      `/interaction/${uid}/federated/org`,
      postSlug(extractCsrf(page), "hosted-acme"),
    );
    expect(retry.status).toBe(303);
  });

  it("refuses a lookup that carries no valid CSRF token", async () => {
    const { jar, uid } = await loginPage();
    const res = await req(
      jar,
      `/interaction/${uid}/federated/org`,
      postSlug("not-the-token", "hosted-acme"),
    );
    expect(res.status).toBe(403);
  });
});
