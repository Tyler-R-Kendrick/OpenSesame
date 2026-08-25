import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ReferenceLdapServer,
  startReferenceLdapServer,
} from "@opensesame/mock-upstream-idp/ldap-server";
import type { OrgLdapConfig } from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { syncLdapDirectory } from "../interactions/ldap.js";
import {
  createLdapInteractionRoutes,
  resetLdapAttemptBudget,
} from "../routes/interactions-ldap.js";
import { createOrgLdapRoutes } from "../routes/org-ldap.js";
import type { startServer } from "../server.js";

/**
 * Directory sync — the pull twin of SCIM push (D17), against a real directory.
 *
 * The whole point of a sync is what it does to people who are no longer there,
 * so the leaver case is the one that matters: membership gone AND every
 * session that membership authorized gone with it, through the same helper
 * SCIM deprovisioning calls. A test that only asserted the membership row
 * would pass while a deprovisioned employee stayed signed in.
 */

type Started = Awaited<ReturnType<typeof startServer>>;

const BASE_DN = "dc=acme,dc=example";
const PEOPLE_DN = `ou=people,${BASE_DN}`;
const ENGINEERS_DN = `cn=engineers,ou=groups,${BASE_DN}`;
const LEADS_DN = `cn=leads,ou=groups,${BASE_DN}`;
const ORG_ID = "org:ldap-sync";
const SLUG = "sync-acme";
const RP_ORIGIN = "http://127.0.0.1:4341";

function secret(): string {
  return randomBytes(24).toString("base64url");
}

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  // SAFETY: probe.listen established the runtime AddressInfo invariant.
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
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

describe("LDAP directory sync", () => {
  let directory: ReferenceLdapServer;
  let started: Started;
  let base: string;
  let issueCsrf: (uid: string) => string;
  const servicePassword = secret();
  const carolPassword = secret();
  const danPassword = secret();
  const carolUuid = randomBytes(16).toString("hex");
  const danUuid = randomBytes(16).toString("hex");

  function config(): OrgLdapConfig {
    return {
      organizationId: ORG_ID,
      url: directory.url,
      // Search-bind, because a sync has no user password to bind with and
      // therefore always needs the service account.
      bindMode: "search_bind",
      searchBaseDn: PEOPLE_DN,
      searchFilter: "(uid={username})",
      serviceBindDn: `cn=service,${BASE_DN}`,
      serviceBindSecret: servicePassword,
      subjectAttribute: "entryUUID",
      attributeMap: { email: "mail", name: "cn" },
      groupRoleMap: { engineers: "member", [LEADS_DN]: "owner" },
    };
  }

  function personEntry(
    uid: string,
    uuid: string,
    password: string,
    groups: string[],
  ) {
    return {
      dn: `uid=${uid},${PEOPLE_DN}`,
      password,
      attributes: {
        objectClass: ["inetOrgPerson"],
        uid: [uid],
        cn: [`${uid} Example`],
        mail: [`${uid}@acme.example`],
        entryUUID: [uuid],
        memberOf: groups,
      },
    };
  }

  beforeAll(async () => {
    directory = await startReferenceLdapServer({
      baseDn: BASE_DN,
      entries: [
        {
          dn: `cn=service,${BASE_DN}`,
          password: servicePassword,
          attributes: { objectClass: ["applicationProcess"], cn: ["service"] },
        },
        personEntry("carol", carolUuid, carolPassword, [ENGINEERS_DN]),
        personEntry("dan", danUuid, danPassword, [ENGINEERS_DN]),
      ],
    });

    const port = await reservePort();
    const { startServer: start } = await import("../server.js");
    started = await start({
      config: {
        host: "127.0.0.1",
        port,
        publicUrl: `http://127.0.0.1:${port}`,
        issuer: `http://127.0.0.1:${port}`,
      },
      processEnv: {
        ...process.env,
        OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
      },
    });
    base = `http://127.0.0.1:${started.port}`;

    const { createInteractionCsrf } = await import("../interactions/csrf.js");
    const interactionCsrf = createInteractionCsrf();
    issueCsrf = (uid: string) => interactionCsrf.issue(uid);
    started.app.route(
      "/interaction",
      createLdapInteractionRoutes(interactionCsrf),
    );
    started.app.route("/v1/organizations", createOrgLdapRoutes());

    const now = started.ctx.clock();
    await started.ctx.stores.organizations.set(ORG_ID, {
      id: ORG_ID,
      slug: SLUG,
      displayName: "Sync Acme",
      state: "active",
      createdBy: "prn_seed",
      createdAt: now,
      updatedAt: now,
    });
    await started.ctx.stores.orgFederation.ldapConfigs.put(config());
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await directory.close();
  });

  afterEach(() => {
    resetLdapAttemptBudget();
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

  /** A real sign-in: the only way a directory entry becomes a principal. */
  async function signIn(username: string, password: string) {
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
    const authorize = await req(jar, `/auth?${params.toString()}`);
    const location = authorize.headers.get("location") ?? "";
    const uid = location.slice("/interaction/".length);
    await req(jar, location);

    const completed = await req(jar, `/interaction/${uid}/federated/ldap`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: issueCsrf(uid),
        slug: SLUG,
        username,
        password,
      }),
    });
    expect(completed.status).toBe(303);
    const cookie = completed.headers
      .getSetCookie()
      .find((value) => value.startsWith("os_provisional="));
    if (!cookie) throw new Error("no provisional session issued");
    const accessToken = (cookie.split(";")[0] ?? "").slice(
      "os_provisional=".length,
    );

    const subject = username === "carol" ? carolUuid : danUuid;
    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "ldap",
      issuer: directory.url,
      subject,
    });
    if (!identity) throw new Error("no identity linked");
    return { principalId: identity.principalId, accessToken };
  }

  it("reconciles roles, admits joiners, and leaves other members alone", async () => {
    const carol = await signIn("carol", carolPassword);
    const ctx = started.ctx;

    // Somebody who joined through the tenant's OIDC IdP, not the directory.
    const now = ctx.clock();
    await ctx.stores.organizationMemberships.upsert({
      organizationId: ORG_ID,
      principalId: "prn_sso_member",
      role: "member",
      createdAt: now,
      updatedAt: now,
    });

    // carol is promoted into the leads group between passes.
    directory.putEntry(
      personEntry("carol", carolUuid, carolPassword, [ENGINEERS_DN, LEADS_DN]),
    );

    const summary = await syncLdapDirectory(ctx, config());
    // Both directory people are scanned; only carol has ever authenticated, so
    // only carol can be joined — a directory entry is not an authentication
    // event, and the sync never invents principals (D11/D17).
    expect(summary.scanned).toBe(2);
    expect(summary.deactivated).toBe(0);

    const membership = await ctx.stores.organizationMemberships.find(
      ORG_ID,
      carol.principalId,
    );
    expect(membership?.role).toBe("owner");

    // The SSO member is not a leaver just because the directory never mentions
    // them: only members this directory vouched for are in scope.
    expect(
      await ctx.stores.organizationMemberships.find(ORG_ID, "prn_sso_member"),
    ).toBeDefined();
  });

  it("deactivates a leaver and revokes the sessions that membership authorized", async () => {
    const dan = await signIn("dan", danPassword);
    const ctx = started.ctx;

    // The bearer works while dan is still in the directory.
    const before = await fetch(`${base}/v1/principals/me`, {
      headers: { authorization: `Bearer ${dan.accessToken}` },
    });
    expect(before.status).toBe(200);
    expect(
      await ctx.stores.organizationMemberships.find(ORG_ID, dan.principalId),
    ).toBeDefined();

    // dan leaves the company.
    expect(directory.removeEntry(`uid=dan,${PEOPLE_DN}`)).toBe(true);
    const summary = await syncLdapDirectory(ctx, config());
    expect(summary.deactivated).toBe(1);

    expect(
      await ctx.stores.organizationMemberships.find(ORG_ID, dan.principalId),
    ).toBeUndefined();
    // And the session goes with the membership — the difference between a
    // deprovisioning and a note in a table.
    const after = await fetch(`${base}/v1/principals/me`, {
      headers: { authorization: `Bearer ${dan.accessToken}` },
    });
    expect(after.status).toBe(401);

    const events = await ctx.repos.auditEvents.list({ limit: 500 });
    expect(
      events.some(
        (event) =>
          event.eventType === "organization.member_revoked" &&
          event.metadata?.reason === "ldap_directory_sync",
      ),
    ).toBe(true);
    // A repeated pass is idempotent: the leaver is already gone.
    expect((await syncLdapDirectory(ctx, config())).deactivated).toBe(0);
  });

  it("treats an empty scan as a broken configuration, not a mass resignation", async () => {
    const ctx = started.ctx;
    const before =
      await ctx.stores.organizationMemberships.listByOrganization(ORG_ID);
    expect(before.length).toBeGreaterThan(0);

    // A filter that matches nothing — the shape a moved base DN, a revoked
    // service account or a typo all produce.
    const summary = await syncLdapDirectory(ctx, {
      ...config(),
      searchFilter: "(uid=nobody-{username})",
    });
    expect(summary.scanned).toBe(0);
    expect(summary.deactivated).toBe(0);
    expect(
      (await ctx.stores.organizationMemberships.listByOrganization(ORG_ID))
        .length,
    ).toBe(before.length);
  });

  it("runs from the owner-triggered route, and only for an owner", async () => {
    const ctx = started.ctx;
    const jar = new Jar();
    const ownerSession = overlapCast(
      await (
        await req(jar, "/v1/principals/provisional", { method: "POST" })
      ).json(),
    );
    const strangerSession = overlapCast(
      await (
        await req(new Jar(), "/v1/principals/provisional", { method: "POST" })
      ).json(),
    );
    const ownerId = `${ownerSession.principalId}`;
    const now = ctx.clock();
    await ctx.stores.organizationMemberships.upsert({
      organizationId: ORG_ID,
      principalId: ownerId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });

    const stranger = await fetch(
      `${base}/v1/organizations/${ORG_ID}/ldap/sync`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${strangerSession.accessToken}` },
      },
    );
    // Not a member: 404 rather than 403, so the route is not an existence
    // oracle for other people's organizations.
    expect(stranger.status).toBe(404);

    const owner = await fetch(`${base}/v1/organizations/${ORG_ID}/ldap/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerSession.accessToken}` },
    });
    expect(owner.status).toBe(200);
    const summary = overlapCast(await owner.json());
    expect(summary.scanned).toBe(1);
    expect(summary.deactivated).toBe(0);
  });

  it("refuses to sync a directory configured without a service account", async () => {
    const ctx = started.ctx;
    const jar = new Jar();
    const session = overlapCast(
      await (
        await req(jar, "/v1/principals/provisional", { method: "POST" })
      ).json(),
    );
    const now = ctx.clock();
    await ctx.stores.organizationMemberships.upsert({
      organizationId: ORG_ID,
      principalId: `${session.principalId}`,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.stores.orgFederation.ldapConfigs.put({
      organizationId: ORG_ID,
      url: directory.url,
      bindMode: "bind_template",
      bindTemplate: `uid={username},${PEOPLE_DN}`,
      subjectAttribute: "entryUUID",
      attributeMap: {},
      groupRoleMap: {},
    });

    const refused = await fetch(
      `${base}/v1/organizations/${ORG_ID}/ldap/sync`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${session.accessToken}` },
      },
    );
    expect(refused.status).toBe(400);
    expect(overlapCast(await refused.json()).error).toBe("incomplete");

    await ctx.stores.orgFederation.ldapConfigs.put(config());
  });
});
