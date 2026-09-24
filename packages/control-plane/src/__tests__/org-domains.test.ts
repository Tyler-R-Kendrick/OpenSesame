import { createHash, randomBytes } from "node:crypto";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { orgDomainDependencies } from "../routes/org-domains.js";
import type { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";

/**
 * Organization email domains and home-realm discovery (C16, D12).
 *
 * The realm half runs against a real control-plane server over a real socket,
 * because the thing under test is a browser flow: a CSP-constrained form POST
 * that must 303 into an interaction the OIDC provider actually created. An
 * in-process handler call would prove none of that.
 *
 * The DNS half substitutes `orgDomainDependencies.resolveTxt`, the module's one
 * imported collaborator. There is no honest "real server" alternative for it —
 * the counterparty is the public DNS hierarchy, and a test that resolved a live
 * name would be asserting on somebody else's zone file. The substitute answers
 * in the exact shape and with the exact failure mode `node:dns/promises` uses:
 * chunk arrays, and a thrown `ENOTFOUND`.
 */

type Started = Awaited<ReturnType<typeof startServer>>;

/** An address whose local part is distinctive enough to grep for. */
const WORK_EMAIL = "ada.lovelace@acme.example";
const WORK_DOMAIN = "acme.example";

const UPSTREAM_ISSUER = "https://idp.example";
const RP_ORIGIN = "http://127.0.0.1:4331";
const RP_CLIENT_ID = `origin:${RP_ORIGIN}`;
const RP_REDIRECT = `${RP_ORIGIN}/opensesame/callback`;

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

function extractCsrf(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match?.[1]) throw new Error("no csrf token in page");
  return match[1];
}

let started: Started;
let base: string;
const originalResolveTxt = orgDomainDependencies.resolveTxt;

beforeAll(async () => {
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
        OPENSESAME_TRUSTED_UPSTREAMS: UPSTREAM_ISSUER,
        // Anything this flow logs must be visible to the sweep below.
        OPENSESAME_LOG_LEVEL: "trace",
      },
    }),
  );
  base = `http://127.0.0.1:${started.port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    started.server.close((err) => (err ? reject(err) : resolve())),
  );
});

afterEach(() => {
  orgDomainDependencies.resolveTxt = originalResolveTxt;
});

function txtRecordsOf(...values: string[]) {
  // The real resolver hands back one chunk array per record.
  return async () => values.map((value) => [value]);
}

function noSuchDomain() {
  return async () => {
    throw Object.assign(new Error("queryTxt ENOTFOUND"), {
      code: "ENOTFOUND",
    });
  };
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  const body: JsonObject = text ? overlapCast(JSON.parse(text)) : {};
  return { status: res.status, body, raw: res };
}

function json(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function verifiedPrincipal(): Promise<string> {
  // A distinct user-agent per mint: the provisional budget is per client
  // fingerprint, and every case in this file would otherwise look like one
  // very busy browser.
  const created = await api("/v1/principals/provisional", {
    method: "POST",
    headers: { "user-agent": `os-test-${randomBytes(6).toString("hex")}` },
  });
  expect(created.status).toBe(201);
  const accessToken = String(created.body.accessToken);
  const linked = await api("/v1/principals/link-identities", {
    method: "POST",
    headers: json(accessToken),
    body: JSON.stringify({
      kind: "oidc",
      issuer: UPSTREAM_ISSUER,
      subject: `owner-${randomBytes(6).toString("hex")}`,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return accessToken;
}

async function seedOrg(slug: string) {
  const ownerToken = await verifiedPrincipal();
  const created = await api("/v1/organizations", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({
      slug,
      displayName: `Org ${slug}`,
      ssoIssuer: UPSTREAM_ISSUER,
    }),
  });
  expect(created.status).toBe(201);
  return { id: String(created.body.id), ownerToken };
}

async function claimDomain(orgId: string, ownerToken: string, domain: string) {
  return api(`/v1/organizations/${orgId}/domains`, {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ domain }),
  });
}

function verifyDomain(orgId: string, ownerToken: string, domain: string) {
  return api(
    `/v1/organizations/${orgId}/domains/${encodeURIComponent(domain)}/verify`,
    { method: "POST", headers: json(ownerToken) },
  );
}

/** Drive `/auth` to a real interaction and return its login page. */
async function loginPage() {
  const jar = new Jar();
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    client_id: RP_CLIENT_ID,
    redirect_uri: RP_REDIRECT,
    response_type: "code",
    scope: "openid",
    state: "s-1",
    nonce: "n-1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const res = await fetch(`${base}/auth?${params.toString()}`, {
    redirect: "manual",
    headers: jar.header(),
  });
  jar.absorb(res);
  expect(res.status).toBe(303);
  const location = res.headers.get("location") ?? "";
  const uid = location.slice("/interaction/".length);
  const page = await fetch(`${base}${location}`, {
    redirect: "manual",
    headers: jar.header(),
  });
  jar.absorb(page);
  return { jar, uid, html: await page.text() };
}

async function submitRealm(
  jar: Jar,
  uid: string,
  csrf: string,
  email: string,
): Promise<Response> {
  const res = await fetch(`${base}/interaction/${uid}/federated/realm`, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...jar.header(),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ _csrf: csrf, email }).toString(),
  });
  jar.absorb(res);
  return res;
}

describe("organization email domain claims", () => {
  it("issues a TXT challenge and verifies the published record", async () => {
    const org = await seedOrg("verify-org");
    const claimed = await claimDomain(
      org.id,
      org.ownerToken,
      "Verify-ORG.example",
    );
    expect(claimed.status).toBe(201);
    // Lowercased on the way in, so one domain is one claim.
    expect(claimed.body.domain).toBe("verify-org.example");
    expect(String(claimed.body.txtRecord)).toMatch(
      /^opensesame-domain-verify=.+/,
    );
    expect(claimed.body.verifiedAt).toBeNull();

    orgDomainDependencies.resolveTxt = txtRecordsOf(
      "v=spf1 include:example.com ~all",
      String(claimed.body.txtRecord),
    );
    const verified = await verifyDomain(
      org.id,
      org.ownerToken,
      "verify-org.example",
    );
    expect(verified.status).toBe(200);
    expect(verified.body.verifiedAt).not.toBeNull();
  });

  it("answers a missing record and a foreign record identically", async () => {
    const org = await seedOrg("txt-org");
    const claimed = await claimDomain(
      org.id,
      org.ownerToken,
      "txt-org.example",
    );
    expect(claimed.status).toBe(201);

    orgDomainDependencies.resolveTxt = noSuchDomain();
    const absent = await verifyDomain(
      org.id,
      org.ownerToken,
      "txt-org.example",
    );

    orgDomainDependencies.resolveTxt = txtRecordsOf(
      "opensesame-domain-verify=somebody-elses-token",
    );
    const foreign = await verifyDomain(
      org.id,
      org.ownerToken,
      "txt-org.example",
    );

    expect(absent.status).toBe(422);
    expect(foreign.status).toBe(422);
    expect(foreign.body).toEqual(absent.body);
    expect(absent.body.error).toBe("verification_failed");
  });

  it("refuses a domain another organization already claims", async () => {
    const first = await seedOrg("first-claim");
    const second = await seedOrg("second-claim");
    expect(
      (await claimDomain(first.id, first.ownerToken, "contested.example"))
        .status,
    ).toBe(201);
    const contested = await claimDomain(
      second.id,
      second.ownerToken,
      "contested.example",
    );
    expect(contested.status).toBe(409);
    expect(contested.body.error).toBe("domain_taken");
  });

  it("refuses inputs that are not domain names", async () => {
    const org = await seedOrg("shape-org");
    for (const candidate of [
      "not a domain",
      "localhost",
      "user@acme.example",
      "acme.example:8443",
      "https://acme.example/path",
      "*.acme.example",
    ]) {
      const refused = await claimDomain(org.id, org.ownerToken, candidate);
      expect(refused.status, candidate).toBe(400);
    }
  });

  it("fences claims, verification and release to the owner", async () => {
    const org = await seedOrg("fence-org");
    const stranger = await verifiedPrincipal();

    expect((await claimDomain(org.id, stranger, "fence.example")).status).toBe(
      404,
    );
    expect((await verifyDomain(org.id, stranger, "fence.example")).status).toBe(
      404,
    );
    const anonymous = await api(`/v1/organizations/${org.id}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "fence.example" }),
    });
    expect(anonymous.status).toBe(401);
  });

  it("releases a domain, and releasing it again is not found", async () => {
    const org = await seedOrg("release-org");
    await claimDomain(org.id, org.ownerToken, "release.example");
    const path = `/v1/organizations/${org.id}/domains/release.example`;
    expect(
      (await api(path, { method: "DELETE", headers: json(org.ownerToken) }))
        .status,
    ).toBe(204);
    expect(
      (await api(path, { method: "DELETE", headers: json(org.ownerToken) }))
        .status,
    ).toBe(404);
  });
});

describe("home-realm discovery on the hosted login page", () => {
  it("routes a work email to the organization that verified its domain", async () => {
    const org = await seedOrg("acme");
    const claimed = await claimDomain(org.id, org.ownerToken, WORK_DOMAIN);
    orgDomainDependencies.resolveTxt = txtRecordsOf(
      String(claimed.body.txtRecord),
    );
    expect(
      (await verifyDomain(org.id, org.ownerToken, WORK_DOMAIN)).status,
    ).toBe(200);

    const { jar, uid, html } = await loginPage();
    expect(html).toContain("Continue with your work email");
    const res = await submitRealm(jar, uid, extractCsrf(html), WORK_EMAIL);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/interaction/${uid}?org=acme`);
    // Not even in the redirect: the local part is discarded, and the domain
    // has already done its only job.
    expect(res.headers.get("location")).not.toContain("ada.lovelace");
  });

  it("answers unknown and unverified domains identically", async () => {
    const org = await seedOrg("pending-org");
    // Claimed, never verified: it must route exactly nothing.
    await claimDomain(org.id, org.ownerToken, "pending.example");

    const first = await loginPage();
    const unverified = await submitRealm(
      first.jar,
      first.uid,
      extractCsrf(first.html),
      "someone@pending.example",
    );
    const second = await loginPage();
    const unknown = await submitRealm(
      second.jar,
      second.uid,
      extractCsrf(second.html),
      "someone@nobody-uses-this.example",
    );

    expect(unverified.status).toBe(200);
    expect(unknown.status).toBe(200);
    const strip = (html: string, uid: string) =>
      html
        .replaceAll(/name="_csrf" value="[^"]+"/g, 'name="_csrf" value="X"')
        .replaceAll(uid, "UID");
    expect(strip(await unverified.text(), first.uid)).toBe(
      strip(await unknown.text(), second.uid),
    );
  });

  it("re-renders with a token the next submit can spend", async () => {
    const { jar, uid, html } = await loginPage();
    const stale = extractCsrf(html);
    const rejected = await submitRealm(
      jar,
      uid,
      stale,
      "someone@unknown.example",
    );
    expect(rejected.status).toBe(200);
    const rerendered = await rejected.text();

    // The submitted token was consumed by `verify`; re-using it must fail and
    // the fresh one the re-render carried must work (T13).
    const replayed = await submitRealm(
      jar,
      uid,
      stale,
      "someone@unknown.example",
    );
    expect(replayed.status).toBe(403);
    const fresh = await submitRealm(
      jar,
      uid,
      extractCsrf(rerendered),
      "someone@unknown.example",
    );
    expect(fresh.status).toBe(200);
  });

  it("leaves the submitted address in no log, no audit row and no store", async () => {
    const org = await seedOrg("sweep-org");
    const claimed = await claimDomain(org.id, org.ownerToken, "sweep.example");
    orgDomainDependencies.resolveTxt = txtRecordsOf(
      String(claimed.body.txtRecord),
    );
    await verifyDomain(org.id, org.ownerToken, "sweep.example");

    const captured: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    const record = (chunk: string | Uint8Array) => {
      captured.push(String(chunk));
    };
    // Recorded and forwarded: swallowing the stream would hide the reporter's
    // own output, and the point is only to read what the server emitted.
    //
    // SAFETY: the replacement takes the string chunk pino actually writes and delegates to the bound original, so the stream keeps its contract.
    process.stdout.write = ((chunk: string) => {
      record(chunk);
      return stdout(chunk);
    }) as typeof process.stdout.write;
    // SAFETY: as above, for the error stream.
    process.stderr.write = ((chunk: string) => {
      record(chunk);
      return stderr(chunk);
    }) as typeof process.stderr.write;

    const address = "grace.hopper@sweep.example";
    try {
      const routed = await loginPage();
      const res = await submitRealm(
        routed.jar,
        routed.uid,
        extractCsrf(routed.html),
        address,
      );
      expect(res.status).toBe(303);
      // And once more for a domain that routes nowhere: the failure path is
      // where an address usually ends up in an error message.
      const missed = await loginPage();
      await submitRealm(
        missed.jar,
        missed.uid,
        extractCsrf(missed.html),
        "grace.hopper@nowhere.example",
      );
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }

    const ctx = started.ctx;
    const trail = JSON.stringify(
      await ctx.repos.auditEvents.list({ limit: 500 }),
    );
    const domains = JSON.stringify(
      await ctx.stores.orgFederation.emailDomains.listByOrganization(org.id),
    );
    const sessions = JSON.stringify([
      ...ctx.stores.provisionalSessions.values(),
    ]);
    const identities = JSON.stringify(
      await ctx.repos.externalIdentities.listByEmailNormalized(address),
    );

    for (const [what, haystack] of [
      ["logs", captured.join("")],
      ["audit trail", trail],
      ["domain store", domains],
      ["sessions", sessions],
    ] as const) {
      expect(haystack, what).not.toContain(address);
      expect(haystack, what).not.toContain("grace.hopper");
    }
    expect(identities).toBe("[]");
    // The domain itself is a public fact and is stored — that is the record
    // the routing reads.
    expect(domains).toContain("sweep.example");
  });
});
