import { createHash, randomBytes } from "node:crypto";
import {
  type ReferenceLdapServer,
  startReferenceLdapServer,
} from "@opensesame/mock-upstream-idp/ldap-server";
import type { OrgLdapConfig } from "@opensesame/os-domain";
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
import {
  LdapConfigurationError,
  assertUsableLdapConfig,
  ldapBind,
  ldapIssuer,
  roleForGroups,
} from "../interactions/ldap.js";
import { resetLdapAttemptBudget } from "../routes/interactions-ldap.js";
import type { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";
import { hopUrl } from "./upstream-hop.js";

/**
 * Native LDAP sign-in, against a REAL directory.
 *
 * Every bind below crosses a socket to an in-process LDAP server speaking the
 * actual protocol (BER-encoded bind and search requests, real result codes).
 * No client is stubbed and no protocol is simulated — a test that faked the
 * directory would prove nothing about the one thing this leg has to get right,
 * which is how a real server's answers become an OpenSesame principal.
 *
 * Fixtures — DNs, group memberships, and every password — are generated at
 * runtime and die with the server (T19/T34). Nothing here is committed.
 */

type Started = Awaited<ReturnType<typeof startServer>>;

const BASE_DN = "dc=acme,dc=example";
const PEOPLE_DN = `ou=people,${BASE_DN}`;
const ENGINEERS_DN = `cn=engineers,ou=groups,${BASE_DN}`;
const ADMINS_DN = `cn=directory-admins,ou=groups,${BASE_DN}`;

/** Every credential in this suite is minted here and never written down. */
function secret(): string {
  return randomBytes(24).toString("base64url");
}

type Directory = {
  server: ReferenceLdapServer;
  servicePassword: string;
  alicePassword: string;
  bobPassword: string;
  aliceUuid: string;
  bobUuid: string;
};

async function startDirectory(): Promise<Directory> {
  const servicePassword = secret();
  const alicePassword = secret();
  const bobPassword = secret();
  const aliceUuid = randomBytes(16).toString("hex");
  const bobUuid = randomBytes(16).toString("hex");
  const server = await startReferenceLdapServer({
    baseDn: BASE_DN,
    entries: [
      {
        dn: `cn=service,${BASE_DN}`,
        password: servicePassword,
        attributes: { objectClass: ["applicationProcess"], cn: ["service"] },
      },
      {
        dn: `uid=alice,${PEOPLE_DN}`,
        password: alicePassword,
        attributes: {
          objectClass: ["inetOrgPerson"],
          uid: ["alice"],
          cn: ["Alice Example"],
          mail: ["alice@acme.example"],
          entryUUID: [aliceUuid],
          memberOf: [ENGINEERS_DN, ADMINS_DN],
        },
      },
      {
        dn: `uid=bob,${PEOPLE_DN}`,
        password: bobPassword,
        attributes: {
          objectClass: ["inetOrgPerson"],
          uid: ["bob"],
          cn: ["Bob Example"],
          mail: ["bob@acme.example"],
          entryUUID: [bobUuid],
          memberOf: [ENGINEERS_DN],
        },
      },
    ],
  });
  return {
    server,
    servicePassword,
    alicePassword,
    bobPassword,
    aliceUuid,
    bobUuid,
  };
}

function templateConfig(directory: Directory): OrgLdapConfig {
  return {
    organizationId: "org:ldap",
    url: directory.server.url,
    bindMode: "bind_template",
    bindTemplate: `uid={username},${PEOPLE_DN}`,
    subjectAttribute: "entryUUID",
    attributeMap: { email: "mail", name: "cn" },
    groupRoleMap: { [ENGINEERS_DN]: "member", "directory-admins": "owner" },
  };
}

function searchConfig(directory: Directory): OrgLdapConfig {
  return {
    organizationId: "org:ldap",
    url: directory.server.url,
    bindMode: "search_bind",
    searchBaseDn: PEOPLE_DN,
    searchFilter: "(uid={username})",
    serviceBindDn: `cn=service,${BASE_DN}`,
    serviceBindSecret: directory.servicePassword,
    subjectAttribute: "entryUUID",
    attributeMap: { email: "mail", name: "cn" },
    groupRoleMap: { engineers: "member" },
  };
}

describe("ldapBind — both modes, against the reference directory", () => {
  let directory: Directory;

  beforeAll(async () => {
    directory = await startDirectory();
  }, 30_000);

  afterAll(async () => {
    await directory.server.close();
  });

  it("binds with a DN template and returns the stable subject, not the DN", async () => {
    const { ctx } = createControlPlane();
    const result = await ldapBind(
      ctx,
      templateConfig(directory),
      "alice",
      directory.alicePassword,
    );

    expect(result).toEqual({
      ok: true,
      subject: directory.aliceUuid,
      email: "alice@acme.example",
      name: "Alice Example",
      groups: [ENGINEERS_DN, ADMINS_DN],
    });
    // The DN is the one thing that must NEVER become the subject (T34): it
    // moves the day somebody changes team.
    if (!result.ok) throw new Error("unreachable");
    expect(result.subject).not.toContain("uid=alice");
  });

  it("binds by service search and then as the entry it found", async () => {
    const { ctx } = createControlPlane();
    const result = await ldapBind(
      ctx,
      searchConfig(directory),
      "bob",
      directory.bobPassword,
    );

    expect(result).toEqual({
      ok: true,
      subject: directory.bobUuid,
      email: "bob@acme.example",
      name: "Bob Example",
      groups: [ENGINEERS_DN],
    });
    // The user's own DN was bound, not just the service account's: the service
    // bind proves nothing about the human at the keyboard.
    expect(directory.server.bindAttempts()).toContain(
      `uid=bob,${PEOPLE_DN}`.toLowerCase(),
    );
  });

  it("answers a wrong password and an unknown user identically, in both modes", async () => {
    const { ctx } = createControlPlane();
    for (const config of [templateConfig(directory), searchConfig(directory)]) {
      const wrongPassword = await ldapBind(ctx, config, "alice", secret());
      const unknownUser = await ldapBind(
        ctx,
        config,
        "nobody-here",
        directory.alicePassword,
      );
      // Byte-identical results: the login form must not be a directory
      // enumeration oracle, and the reference server deliberately answers
      // `noSuchObject` for one and `invalidCredentials` for the other so the
      // uniformity has to come from this side.
      expect(wrongPassword).toEqual({ ok: false });
      expect(unknownUser).toEqual({ ok: false });
      expect(JSON.stringify(unknownUser)).toBe(JSON.stringify(wrongPassword));
    }
  });

  it("refuses an empty password instead of letting it become an anonymous bind", async () => {
    const { ctx } = createControlPlane();
    const before = directory.server.bindAttempts().length;
    const result = await ldapBind(ctx, templateConfig(directory), "alice", "");
    expect(result).toEqual({ ok: false });
    // LDAP reads an empty credential as an *unauthenticated* bind and answers
    // success, so the request must never reach the wire at all.
    expect(directory.server.bindAttempts().length).toBe(before);
  });

  it("escapes a hostile username instead of letting it rewrite the filter", async () => {
    const { ctx } = createControlPlane();
    const injected = await ldapBind(
      ctx,
      searchConfig(directory),
      "nobody)(uid=*",
      directory.alicePassword,
    );
    expect(injected).toEqual({ ok: false });
  });

  it("maps groups to roles by DN or by cn, strongest match winning", () => {
    const config = templateConfig(directory);
    expect(roleForGroups(config, [ENGINEERS_DN])).toBe("member");
    // alice is in both; owner must win however the map is ordered.
    expect(roleForGroups(config, [ENGINEERS_DN, ADMINS_DN])).toBe("owner");
    expect(roleForGroups(config, [`cn=nobody,ou=groups,${BASE_DN}`])).toBe(
      undefined,
    );
  });

  it("derives one issuer per directory, from scheme, host and port", () => {
    expect(ldapIssuer(templateConfig(directory))).toBe(directory.server.url);
  });
});

describe("LDAP configuration fences", () => {
  let directory: Directory;

  beforeAll(async () => {
    directory = await startDirectory();
  }, 30_000);

  afterAll(async () => {
    await directory.server.close();
  });

  function production() {
    return createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        allowDevDefaults: false,
      },
    }).ctx;
  }

  it("refuses plain ldap:// once dev defaults are off", async () => {
    const config = templateConfig(directory);
    expect(() => assertUsableLdapConfig(production(), config)).toThrow(
      LdapConfigurationError,
    );
    try {
      assertUsableLdapConfig(production(), config);
    } catch (error) {
      expect(error).toBeInstanceOf(LdapConfigurationError);
      if (error instanceof LdapConfigurationError) {
        expect(error.code).toBe("tls_required");
      }
    }
    // The same configuration is fine where the reference directory runs.
    expect(() =>
      assertUsableLdapConfig(createControlPlane().ctx, config),
    ).not.toThrow();
  });

  it("refuses a directory aimed at a private or metadata address", () => {
    for (const url of [
      "ldaps://169.254.169.254",
      "ldaps://10.1.2.3:636",
      "ldaps://metadata.google.internal",
      "ldaps://[::1]:636",
    ]) {
      const config: OrgLdapConfig = { ...templateConfig(directory), url };
      let code: string | undefined;
      try {
        assertUsableLdapConfig(production(), config);
      } catch (error) {
        if (error instanceof LdapConfigurationError) code = error.code;
      }
      expect(code).toBe("unsafe_host");
    }
  });

  it("refuses to store an owner-submitted directory on a private host", async () => {
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        allowDevDefaults: false,
      },
    });
    const session = overlapCast(
      await (
        await app.request("/v1/principals/provisional", { method: "POST" })
      ).json(),
    );
    const now = ctx.clock();
    const organizationId = "org:guarded";
    await ctx.stores.organizations.set(organizationId, {
      id: organizationId,
      slug: "guarded",
      displayName: "Guarded",
      state: "active",
      createdBy: `${session.principalId}`,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.stores.organizationMemberships.upsert({
      organizationId,
      principalId: `${session.principalId}`,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });

    const body = {
      url: "ldaps://169.254.169.254",
      bindMode: "bind_template",
      bindTemplate: `uid={username},${PEOPLE_DN}`,
      subjectAttribute: "entryUUID",
      attributeMap: {},
      groupRoleMap: {},
    };
    const refused = await app.request(
      `/v1/organizations/${organizationId}/ldap`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    // An org owner is trusted with their tenant, not with this server's
    // network position: the config never reaches the store.
    expect(refused.status).toBe(400);
    expect(overlapCast(await refused.json()).error).toBe("unsafe_host");
    expect(
      await ctx.stores.orgFederation.ldapConfigs.get(organizationId),
    ).toBeNull();
  });

  it("refuses a URL that is not LDAP at all", () => {
    const config: OrgLdapConfig = {
      ...templateConfig(directory),
      url: "https://directory.acme.example",
    };
    let code: string | undefined;
    try {
      assertUsableLdapConfig(createControlPlane().ctx, config);
    } catch (error) {
      if (error instanceof LdapConfigurationError) code = error.code;
    }
    expect(code).toBe("invalid_url");
  });

  it("refuses a mode whose required fields are missing", () => {
    const incomplete: OrgLdapConfig = {
      organizationId: "org:ldap",
      url: directory.server.url,
      bindMode: "search_bind",
      searchBaseDn: PEOPLE_DN,
      subjectAttribute: "entryUUID",
      attributeMap: {},
      groupRoleMap: {},
    };
    let code: string | undefined;
    try {
      assertUsableLdapConfig(createControlPlane().ctx, incomplete);
    } catch (error) {
      if (error instanceof LdapConfigurationError) code = error.code;
    }
    expect(code).toBe("incomplete");
  });
});

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

describe("directory sign-in from the hosted login page", () => {
  const RP_ORIGIN = "http://127.0.0.1:4331";
  const ORG_ID = "org:ldap-hosted";
  let directory: Directory;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    directory = await startDirectory();
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
        },
      }),
    );
    base = `http://127.0.0.1:${started.port}`;

    const now = started.ctx.clock();
    await started.ctx.stores.organizations.set(ORG_ID, {
      id: ORG_ID,
      slug: "ldap-acme",
      displayName: "LDAP Acme",
      state: "active",
      createdBy: "prn_seed",
      createdAt: now,
      updatedAt: now,
    });
    await started.ctx.stores.orgFederation.ldapConfigs.put({
      ...templateConfig(directory),
      organizationId: ORG_ID,
    });
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await directory.server.close();
  });

  afterEach(() => {
    resetLdapAttemptBudget();
    vi.restoreAllMocks();
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

  function extractCsrf(html: string): string {
    const match = html.match(/name="_csrf" value="([^"]+)"/);
    if (!match?.[1]) throw new Error("no csrf token in page");
    return match[1];
  }

  /**
   * Drive `/auth` the way a static relying party does, to reach a real
   * interaction — then render its login page for that tenant, which is where
   * the directory form and its single-use CSRF token come from. Nothing is
   * mounted ad hoc: the sub-router under test is the one `createInteractionRoutes`
   * mounts, reached over a socket on the running server.
   */
  async function loginInteraction(slug?: string) {
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
    const page = await req(
      jar,
      slug === undefined
        ? location
        : `${location}?org=${encodeURIComponent(slug)}`,
    );
    const html = await page.text();
    return { jar, uid, html, csrf: extractCsrf(html) };
  }

  function postCredentials(
    token: string,
    username: string,
    password: string,
    slug = "ldap-acme",
  ): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: token,
        slug,
        username,
        password,
      }),
    };
  }

  it("signs a directory user in, as one principal with a JIT role from their groups", async () => {
    const { jar, uid, html, csrf } = await loginInteraction("ldap-acme");
    // The form the visitor actually fills in: rendered by the login page for a
    // tenant with a directory, posting to the mounted sub-router, and script-
    // less because these pages ship under `default-src 'none'` (T5).
    expect(html).toContain(`/interaction/${uid}/federated/ldap`);
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="slug" value="ldap-acme"');
    expect(html).not.toContain("<script");

    const response = await req(
      jar,
      `/interaction/${uid}/federated/ldap`,
      postCredentials(csrf, "alice", directory.alicePassword),
    );
    expect(await hopUrl(response)).toContain("/auth/");

    const ctx = started.ctx;
    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind: "ldap",
      issuer: directory.server.url,
      subject: directory.aliceUuid,
    });
    expect(identity?.assurance).toBe("verified");
    if (!identity) throw new Error("no identity linked");

    const principal = await ctx.repos.principals.getById(identity.principalId);
    expect(principal?.state).toBe("active");
    expect(principal?.assurance).toBe("verified");

    // `cn=directory-admins` maps to owner; the weaker engineers membership
    // must not decide the role.
    const membership = await ctx.stores.organizationMemberships.find(
      ORG_ID,
      identity.principalId,
    );
    expect(membership?.role).toBe("owner");

    // The directory's `mail` attribute is stored, but the organization has not
    // proved it owns acme.example, so it is NOT a linking key (D15/D17).
    expect(identity.emailNormalized).toBe("alice@acme.example");
    expect(identity.emailVerified).toBe(false);
  });

  it("signs the same directory user back in without minting a second principal", async () => {
    const first = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "ldap",
      issuer: directory.server.url,
      subject: directory.aliceUuid,
    });
    const { jar, uid, csrf } = await loginInteraction();
    const response = await req(
      jar,
      `/interaction/${uid}/federated/ldap`,
      postCredentials(csrf, "alice", directory.alicePassword),
    );
    expect(await hopUrl(response)).toContain("/auth/");
    // A returning user gets no fresh provisional cookie (T6).
    expect(
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith("os_provisional=")),
    ).toBe(false);

    const again = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "ldap",
      issuer: directory.server.url,
      subject: directory.aliceUuid,
    });
    expect(again?.principalId).toBe(first?.principalId);
  });

  it("answers a wrong password and an unknown user with the same page", async () => {
    const wrong = await loginInteraction();
    const wrongResponse = await req(
      wrong.jar,
      `/interaction/${wrong.uid}/federated/ldap`,
      postCredentials(wrong.csrf, "alice", secret()),
    );
    const unknown = await loginInteraction();
    const unknownResponse = await req(
      unknown.jar,
      `/interaction/${unknown.uid}/federated/ldap`,
      postCredentials(unknown.csrf, "not-a-person", directory.alicePassword),
    );

    expect(wrongResponse.status).toBe(401);
    expect(unknownResponse.status).toBe(401);
    const wrongPage = await wrongResponse.text();
    const unknownPage = await unknownResponse.text();
    expect(wrongPage).toContain(
      "That username and password were not accepted.",
    );
    // The pages differ only in their single-use CSRF token and interaction id.
    const scrub = (html: string) =>
      html
        .replace(/name="_csrf" value="[^"]+"/g, "")
        .replaceAll(wrong.uid, "<uid>")
        .replaceAll(unknown.uid, "<uid>");
    expect(scrub(unknownPage)).toBe(scrub(wrongPage));
    expect(wrongPage).not.toContain("<script");
  });

  it("never writes the password to the audit trail or to the logs", async () => {
    const password = directory.bobPassword;
    const captured: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      captured.push(isString(chunk) ? chunk : Buffer.from(chunk).toString());
      return true;
    };
    // SAFETY: the spied signature carries optional encoding/callback
    // parameters this capture ignores; both overloads return boolean.
    vi.spyOn(process.stdout, "write").mockImplementation(overlapCast(capture));
    // SAFETY: as above, for the error stream.
    vi.spyOn(process.stderr, "write").mockImplementation(overlapCast(capture));

    const good = await loginInteraction();
    const success = await req(
      good.jar,
      `/interaction/${good.uid}/federated/ldap`,
      postCredentials(good.csrf, "bob", password),
    );
    const bad = await loginInteraction();
    const failure = await req(
      bad.jar,
      `/interaction/${bad.uid}/federated/ldap`,
      postCredentials(bad.csrf, "bob", secret()),
    );
    vi.restoreAllMocks();

    expect(await hopUrl(success)).toContain("/auth/");
    expect(failure.status).toBe(401);

    const events = await started.ctx.repos.auditEvents.list({ limit: 500 });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain("password");
    expect(captured.join("")).not.toContain(password);

    // The trail still records the admission itself — silence would be its own
    // failure.
    expect(
      events.some(
        (event) =>
          event.eventType === "principal.identity_linked" &&
          event.metadata?.via === "ldap_bind",
      ),
    ).toBe(true);
  });

  it("refuses a post with no valid CSRF token", async () => {
    const { jar, uid } = await loginInteraction();
    const res = await req(
      jar,
      `/interaction/${uid}/federated/ldap`,
      postCredentials("not-the-token", "alice", directory.alicePassword),
    );
    expect(res.status).toBe(403);
  });

  it("rate-limits guessing, and says the same thing to an unknown tenant", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const attemptLogin = await loginInteraction();
      const res = await req(
        attemptLogin.jar,
        `/interaction/${attemptLogin.uid}/federated/ldap`,
        postCredentials(attemptLogin.csrf, "alice", secret()),
      );
      expect(res.status).toBe(401);
    }
    const { jar, uid, csrf } = await loginInteraction();
    const limited = await req(
      jar,
      `/interaction/${uid}/federated/ldap`,
      postCredentials(csrf, "alice", secret()),
    );
    expect(limited.status).toBe(429);

    resetLdapAttemptBudget();
    const unknown = await loginInteraction();
    const noSuchTenant = await req(
      unknown.jar,
      `/interaction/${unknown.uid}/federated/ldap`,
      postCredentials(
        unknown.csrf,
        "alice",
        directory.alicePassword,
        "no-such-tenant",
      ),
    );
    expect(noSuchTenant.status).toBe(401);
    expect(await noSuchTenant.text()).toContain(
      "That username and password were not accepted.",
    );
  });

  it("keeps the service bind secret out of every owner-facing read", async () => {
    // Mint an owner the way the rest of the suite does, then read the config
    // back: the secret is presented to the directory verbatim and therefore
    // cannot be hashed, so never returning it is the only fence left.
    const jar = new Jar();
    const created = await req(jar, "/v1/principals/provisional", {
      method: "POST",
    });
    const session = overlapCast(await created.json());
    const now = started.ctx.clock();
    await started.ctx.stores.organizationMemberships.upsert({
      organizationId: ORG_ID,
      principalId: `${session.principalId}`,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await started.ctx.stores.orgFederation.ldapConfigs.put({
      ...searchConfig(directory),
      organizationId: ORG_ID,
    });

    const read = await fetch(`${base}/v1/organizations/${ORG_ID}/ldap`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(read.status).toBe(200);
    const body = await read.text();
    expect(body).not.toContain(directory.servicePassword);
    expect(body).toContain('"serviceBindConfigured":true');

    // Restore the template configuration the rest of the suite assumes.
    await started.ctx.stores.orgFederation.ldapConfigs.put({
      ...templateConfig(directory),
      organizationId: ORG_ID,
    });
  });
});
