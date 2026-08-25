import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import {
  type ByoRegistrationResult,
  registerByoUpstream,
  resetByoBudget,
} from "../interactions/byo.js";
import {
  decodePending,
  resetFederatedDiscoveryCache,
} from "../interactions/federated.js";
import type { startServer } from "../server.js";

/**
 * Bring your own identity provider, end to end (S4: C9 + D5).
 *
 * Every counterparty here is the reference IdP (C18): a real OIDC server over
 * real HTTP, with keys generated at startup, a real RFC 7591 registration
 * endpoint when asked for one, and PKCE S256 enforced on the way through. The
 * point of the feature is that a first-time visitor with no account can name
 * an issuer this deployment has never heard of and end up as one canonical,
 * verified principal — so the assertions below are about identity rows and
 * principal state, not about redirects that merely look right.
 */

type Started = Awaited<ReturnType<typeof startServer>>;
type ByoForm = {
  _csrf: string;
  issuer?: string;
  client_id?: string;
  client_secret?: string;
};
type LoginPageResult = { jar: Jar; uid: string; html: string };

const RP_ORIGIN = "http://127.0.0.1:4317";
const RP_CLIENT_ID = `origin:${RP_ORIGIN}`;
const RP_REDIRECT = `${RP_ORIGIN}/opensesame/callback`;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Minimal cookie jar: a superset of browser path-scoping, fine for tests. */
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

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header() {
    if (this.cookies.size === 0) return {};
    return {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
  }
}

async function startControlPlane(
  upstreamIssuer: string,
  port: number,
): Promise<Started> {
  const { startServer: start } = await import("../server.js");
  return start({
    config: {
      host: "127.0.0.1",
      port,
      // publicUrl must match the real bound port: it is both the origin-profile
      // client id and the base of the federated redirect_uri.
      publicUrl: `http://127.0.0.1:${port}`,
      issuer: `http://127.0.0.1:${port}`,
    },
    processEnv: {
      ...process.env,
      OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
      OPENSESAME_TRUSTED_UPSTREAMS: upstreamIssuer,
    },
  });
}

/** Reserve a port so publicUrl can name it before the server binds. */
async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  // SAFETY: probe.listen established the runtime AddressInfo invariant.
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function extractCsrf(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match?.[1]) throw new Error("no csrf token in page");
  return match[1];
}

async function req(
  base: string,
  jar: Jar,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const res = await fetch(url, {
    redirect: "manual",
    ...init,
    headers: { ...jar.header(), ...overlapCast(init.headers) },
  });
  jar.absorb(res);
  return res;
}

function postForm(fields: ByoForm): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  };
}

/** The registration outcome as a record, or a failure naming the refusal. */
function expectRecord(outcome: ByoRegistrationResult) {
  if ("error" in outcome) {
    throw new Error(`expected a record, got ${outcome.error}`);
  }
  return outcome.record;
}

describe("bring-your-own upstream", () => {
  /** The deployment's own configured upstream; never the BYO one. */
  let allowlisted: ReferenceIdp;
  let manualIdp: ReferenceIdp;
  let dcrIdp: ReferenceIdp;
  let dcrRejectIdp: ReferenceIdp;
  let noDcrIdp: ReferenceIdp;
  let reentryIdp: ReferenceIdp;
  let roundTripIdp: ReferenceIdp;
  let dcrRoundTripIdp: ReferenceIdp;
  let dcrReentryIdp: ReferenceIdp;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    // The discovery cache is module-global and keyed by issuer + client id;
    // a suite that starts fresh servers must clear it at both ends (T1).
    resetFederatedDiscoveryCache();
    [
      allowlisted,
      manualIdp,
      dcrIdp,
      dcrRejectIdp,
      noDcrIdp,
      reentryIdp,
      roundTripIdp,
      dcrRoundTripIdp,
      dcrReentryIdp,
    ] = await Promise.all([
      startReferenceIdp(),
      startReferenceIdp(),
      startReferenceIdp({ registration: true }),
      startReferenceIdp({ registration: true }),
      startReferenceIdp({ registration: false }),
      startReferenceIdp(),
      startReferenceIdp(),
      startReferenceIdp({ registration: true }),
      startReferenceIdp({ registration: true }),
    ]);
    started = await startControlPlane(allowlisted.issuer, await reservePort());
    base = `http://127.0.0.1:${started.port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await Promise.all([
      allowlisted.close(),
      manualIdp.close(),
      dcrIdp.close(),
      dcrRejectIdp.close(),
      noDcrIdp.close(),
      reentryIdp.close(),
      roundTripIdp.close(),
      dcrRoundTripIdp.close(),
      dcrReentryIdp.close(),
    ]);
    resetFederatedDiscoveryCache();
  });

  // The budget is module-local and deliberately survives requests, so every
  // case starts from a clean one rather than inheriting its neighbours' spend.
  beforeEach(() => {
    resetByoBudget();
  });

  async function loginPage(): Promise<LoginPageResult> {
    const jar = new Jar();
    const { challenge } = pkce();
    const params = new URLSearchParams({
      client_id: RP_CLIENT_ID,
      redirect_uri: RP_REDIRECT,
      response_type: "code",
      scope: "openid",
      state: "s-1",
      nonce: "n-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const res = await req(base, jar, `/auth?${params.toString()}`);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    const uid = location.slice("/interaction/".length);
    const page = await req(base, jar, location);
    return { jar, uid, html: await page.text() };
  }

  /**
   * The deployment-wide callback every leg returns to (ADR 0055) — whether the
   * client came from RFC 7591 or the visitor registered it at their IdP by
   * hand. There is no per-interaction shape any more: an IdP matches a
   * registered redirect URI exactly, so one naming the interaction it was
   * registered from would admit exactly one sign-in.
   */
  function stableCallback(): string {
    return `${base}/v1/federated/callback`;
  }

  describe("registration", () => {
    it("stores the client credentials a visitor brought themselves", async () => {
      const record = expectRecord(
        await registerByoUpstream(
          started.ctx,
          {
            issuer: manualIdp.issuer,
            clientId: manualIdp.clientId,
            clientSecret: manualIdp.clientSecret,
          },
          "fp-manual",
        ),
      );
      expect(record.issuer).toBe(manualIdp.issuer);
      expect(record.clientId).toBe(manualIdp.clientId);
      expect(record.clientAuth).toBe("client_secret_post");
      expect(record.registrationSource).toBe("manual");
      expect(record.state).toBe("active");

      // Durable, because re-entry depends on it: the visitor comes back
      // tomorrow, types the same URL, and this row is what admits them.
      const stored = await started.ctx.repos.byoUpstreams.findByIssuer(
        manualIdp.issuer,
      );
      expect(stored?.id).toBe(record.id);
      expect(stored?.clientSecret).toBe(manualIdp.clientSecret);
    });

    it("registers itself dynamically when the issuer advertises RFC 7591", async () => {
      const record = expectRecord(
        await registerByoUpstream(
          started.ctx,
          { issuer: dcrIdp.issuer, redirectUri: stableCallback() },
          "fp-dcr",
        ),
      );
      expect(record.registrationSource).toBe("dcr");
      // Minted by the IdP's own registration endpoint, not by us.
      expect(record.clientId).toMatch(/^dcr-/);
      expect(record.clientAuth).toBe("client_secret_post");
      expect(record.clientSecret).toBeTruthy();
      expect(record.clientSecret).not.toBe(dcrIdp.clientSecret);
    });

    /**
     * A registration endpoint that refuses us is the same outcome as one that
     * does not exist: the visitor has to bring a client id. The refusal here
     * is real — the reference IdP's RFC 7591 endpoint rejects a `redirect_uri`
     * carrying a fragment, under both client-authentication methods we offer —
     * and what is being asserted is that a 400 from an upstream becomes a
     * refusal a form can render rather than an exception.
     */
    it("refuses when the registration endpoint rejects the metadata", async () => {
      const outcome = await registerByoUpstream(
        started.ctx,
        {
          issuer: dcrRejectIdp.issuer,
          redirectUri: `${stableCallback()}#fragment`,
        },
        "fp-dcr-reject",
      );
      expect(outcome).toEqual({
        error: "registration_unsupported",
        message: expect.stringContaining("client ID"),
      });
      expect(
        await started.ctx.repos.byoUpstreams.findByIssuer(dcrRejectIdp.issuer),
      ).toBeNull();
    });

    it("refuses an issuer that neither registers clients nor was given one", async () => {
      const outcome = await registerByoUpstream(
        started.ctx,
        { issuer: noDcrIdp.issuer, redirectUri: stableCallback() },
        "fp-nodcr",
      );
      expect(outcome).toEqual({
        error: "registration_unsupported",
        message: expect.stringContaining("client ID"),
      });
      expect(
        await started.ctx.repos.byoUpstreams.findByIssuer(noDcrIdp.issuer),
      ).toBeNull();
    });

    it("refuses an issuer that answers with no discovery document", async () => {
      // A real, reachable, allowlist-safe host that is not an OIDC issuer:
      // this deployment's own login surface.
      const outcome = await registerByoUpstream(
        started.ctx,
        { issuer: `${base}/not-an-issuer`, clientId: "c" },
        "fp-nodiscovery",
      );
      expect(outcome).toEqual({
        error: "discovery_failed",
        message: expect.stringContaining("discovery document"),
      });
    });

    /**
     * Re-entry (D5). The second submission names a different client id on
     * purpose: the record is keyed by issuer, and a stranger who guesses
     * somebody else's issuer must not be able to swap the client out from
     * under it. Both answers are shaped identically, so nothing about the
     * first registration leaks into the second.
     */
    it("reuses the record on re-entry without revealing it existed", async () => {
      const first = await registerByoUpstream(
        started.ctx,
        {
          issuer: reentryIdp.issuer,
          clientId: reentryIdp.clientId,
          clientSecret: reentryIdp.clientSecret,
        },
        "fp-reentry-1",
      );
      const second = await registerByoUpstream(
        started.ctx,
        { issuer: reentryIdp.issuer, clientId: "someone-elses-client" },
        "fp-reentry-2",
      );
      const created = expectRecord(first);
      const reused = expectRecord(second);
      expect(reused.id).toBe(created.id);
      expect(reused.clientId).toBe(reentryIdp.clientId);
      expect(reused.createdAt).toEqual(created.createdAt);
      expect(Object.keys(second)).toEqual(Object.keys(first));
    });

    /**
     * A record an operator disabled (D14) signs nobody in — and re-submitting
     * its issuer must not become a way to register around the decision. The
     * refusal lands before any network call, and the stored row is untouched.
     */
    it("refuses a record an operator disabled, without re-creating it", async () => {
      const issuer = "https://disabled.idp.example";
      const id = "byo_disabled_case";
      await started.ctx.repos.byoUpstreams.create({
        id,
        issuer,
        label: "disabled.idp.example",
        clientId: "original-client",
        clientAuth: "none",
        registrationSource: "manual",
        state: "active",
        createdAt: started.ctx.clock(),
      });
      await started.ctx.repos.byoUpstreams.setState(id, "disabled");

      const outcome = await registerByoUpstream(
        started.ctx,
        { issuer, clientId: "replacement-client" },
        "fp-disabled",
      );
      expect(outcome).toEqual({
        error: "discovery_failed",
        message: expect.any(String),
      });
      const record = await started.ctx.repos.byoUpstreams.findByIssuer(issuer);
      expect(record?.id).toBe(id);
      expect(record?.state).toBe("disabled");
      expect(record?.clientId).toBe("original-client");
    });

    /**
     * The issuer arrives in an unauthenticated form field and this server then
     * dereferences it, so the guard is the whole security of this endpoint.
     * Loopback, link-local, cloud metadata, and the decimal spelling that
     * classically walks past a string denylist all have to be refused.
     */
    it.each([
      ["a loopback name", "http://localhost:9099"],
      ["an https loopback name", "https://localhost"],
      ["the cloud metadata address", "http://169.254.169.254"],
      ["a decimal-encoded metadata address", "http://2852039166"],
      ["a localhost subdomain", "http://idp.localhost:9099"],
      ["an https localhost subdomain", "https://tenant.localhost"],
      ["a private address", "https://10.1.2.3"],
      ["a non-http scheme", "ftp://idp.example.com"],
      ["a credential-bearing URL", "https://user:pw@idp.example.com"],
      ["something that is not a URL", "idp.example.com"],
    ])("refuses %s", async (_label, issuer) => {
      const outcome = await registerByoUpstream(
        started.ctx,
        { issuer },
        `fp-ssrf-${issuer}`,
      );
      expect(outcome).toEqual({
        error: "invalid_issuer",
        message: expect.stringContaining("cannot be used"),
      });
    });

    /**
     * The loopback exception exists for the dev stack and nothing else: the
     * reference IdP lives on 127.0.0.1, and a deployment that has NOT opted
     * into dev defaults must refuse it — in every spelling, including the
     * decimal one WHATWG normalizes back to 127.0.0.1.
     */
    it.each([
      ["a loopback literal", "http://127.0.0.1:9090"],
      ["a decimal-encoded loopback", "http://2130706433"],
      ["an https loopback literal", "https://127.0.0.1"],
      ["an http issuer", "http://idp.example.com"],
    ])("refuses %s without dev defaults", async (_label, issuer) => {
      const production: AppContext = {
        ...started.ctx,
        config: { ...started.ctx.config, allowDevDefaults: false },
      };
      const outcome = await registerByoUpstream(
        production,
        { issuer },
        `fp-prod-${issuer}`,
      );
      expect(outcome).toEqual({
        error: "invalid_issuer",
        message: expect.stringContaining("cannot be used"),
      });
    });

    it("refuses a rejected issuer before it reaches the store", async () => {
      await registerByoUpstream(
        started.ctx,
        { issuer: "http://169.254.169.254" },
        "fp-ssrf-store",
      );
      expect(
        await started.ctx.repos.byoUpstreams.findByIssuer(
          "http://169.254.169.254",
        ),
      ).toBeNull();
    });

    /**
     * The abuse fence (D5): five registrations per fingerprint per ten
     * minutes, spent by every attempt that gets past URL validation — a
     * returning visitor's reuse included, because "is this issuer already
     * known?" is exactly the question an enumerator would like to ask for
     * free.
     */
    it("spends a per-fingerprint budget and refuses the sixth attempt", async () => {
      const fingerprint = "fp-budget";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const outcome = await registerByoUpstream(
          started.ctx,
          {
            issuer: manualIdp.issuer,
            clientId: manualIdp.clientId,
            clientSecret: manualIdp.clientSecret,
          },
          fingerprint,
        );
        expect(expectRecord(outcome).issuer).toBe(manualIdp.issuer);
      }
      expect(
        await registerByoUpstream(
          started.ctx,
          { issuer: manualIdp.issuer },
          fingerprint,
        ),
      ).toEqual({
        error: "rate_limited",
        message: expect.stringContaining("Too many"),
      });

      // Another browser is unaffected: the budget is per fingerprint.
      expect(
        expectRecord(
          await registerByoUpstream(
            started.ctx,
            { issuer: manualIdp.issuer },
            "fp-budget-other",
          ),
        ).issuer,
      ).toBe(manualIdp.issuer);

      resetByoBudget();
      expect(
        expectRecord(
          await registerByoUpstream(
            started.ctx,
            { issuer: manualIdp.issuer },
            fingerprint,
          ),
        ).issuer,
      ).toBe(manualIdp.issuer);
    });
  });

  describe("the hosted login page", () => {
    it("offers the bring-your-own form", async () => {
      const { html } = await loginPage();
      expect(html).toContain("Use your own identity provider");
      expect(html).toContain("/federated/byo");
      // No script-src on these pages (T5): the flow is POST → 303 → GET.
      expect(html).not.toContain("<script");
    });

    it("refuses a submission without the CSRF token", async () => {
      const { jar, uid } = await loginPage();
      const res = await req(
        base,
        jar,
        `/interaction/${uid}/federated/byo`,
        postForm({ _csrf: "wrong", issuer: roundTripIdp.issuer }),
      );
      expect(res.status).toBe(403);
      expect(jar.get(`os.fed.${uid}`)).toBeFalsy();
    });

    /**
     * T13: `csrf.verify` consumes the token, so a 422 that echoed the spent
     * one would 403 the visitor's correction — the single most likely thing
     * to happen next on a form whose whole job is being retyped.
     */
    it("re-renders a refusal with a token the next attempt can spend", async () => {
      const { jar, uid, html } = await loginPage();
      const refused = await req(
        base,
        jar,
        `/interaction/${uid}/federated/byo`,
        postForm({ _csrf: extractCsrf(html), issuer: "http://localhost:9099" }),
      );
      expect(refused.status).toBe(422);
      const page = await refused.text();
      expect(page).toContain("cannot be used for sign-in");
      // The rejected URL comes back in the field rather than being wiped.
      expect(page).toContain("http://localhost:9099");

      roundTripIdp.setRedirectUris([stableCallback()]);
      const retried = await req(
        base,
        jar,
        `/interaction/${uid}/federated/byo`,
        postForm({
          _csrf: extractCsrf(page),
          issuer: roundTripIdp.issuer,
          client_id: roundTripIdp.clientId,
          client_secret: roundTripIdp.clientSecret,
        }),
      );
      expect(retried.status).toBe(303);
    });

    /**
     * The definition of done for this swarm: a first-time visitor with no
     * account names their own issuer and ends as ONE canonical principal,
     * `active` + `verified`, with an `external_identities` row naming that
     * issuer — asserted from the store, not inferred from the redirect.
     */
    it("signs a first-time visitor in through their own issuer", async () => {
      const subject = `byo-${randomBytes(4).toString("hex")}`;
      roundTripIdp.setSubject(subject);
      const { jar, uid, html } = await loginPage();
      roundTripIdp.setRedirectUris([stableCallback()]);

      const start = await req(
        base,
        jar,
        `/interaction/${uid}/federated/byo`,
        postForm({
          _csrf: extractCsrf(html),
          issuer: roundTripIdp.issuer,
          client_id: roundTripIdp.clientId,
          client_secret: roundTripIdp.clientSecret,
        }),
      );
      expect(start.status).toBe(303);
      const authorize = new URL(start.headers.get("location") ?? "");
      expect(authorize.origin).toBe(roundTripIdp.issuer);
      // Their client, not our origin profile (T10).
      expect(authorize.searchParams.get("client_id")).toBe(
        roundTripIdp.clientId,
      );
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      // The same deployment-wide URI a dynamic registration names. A visitor
      // registering their own client at their own IdP is shown this exact
      // string on the form, because most consoles match it byte for byte and
      // accept no wildcard.
      expect(authorize.searchParams.get("redirect_uri")).toBe(stableCallback());
      expect(authorize.searchParams.get("state")).toMatch(
        new RegExp(`^${uid}\\..+`),
      );

      const pending = decodePending(jar.get(`os.fed.${uid}`));
      expect(pending?.kind).toBe("oidc");
      expect(pending?.issuer).toBe(roundTripIdp.issuer);
      expect(pending?.byoId).toBeTruthy();

      const upstreamRes = await fetch(authorize, { redirect: "manual" });
      const back = new URL(upstreamRes.headers.get("location") ?? "");
      expect(back.href.startsWith(stableCallback())).toBe(true);

      // The shared callback completes nothing; it hands the browser back to a
      // top-level GET under /interaction/<uid>, where the Lax cookie lives.
      const handBack = await req(base, jar, `${back.pathname}${back.search}`);
      expect(handBack.status).toBe(303);
      const completed = await req(
        base,
        jar,
        handBack.headers.get("location") ?? "",
      );
      expect(completed.status).toBe(303);
      expect(completed.headers.get("location")).toContain("/auth/");
      expect(jar.get("os_provisional")).toBeTruthy();

      const identity = await started.ctx.repos.externalIdentities.findByTuple({
        kind: "oidc",
        issuer: roundTripIdp.issuer,
        // A confidential client sees the IdP's canonical subject; only
        // origin-profile clients get a pairwise one.
        subject,
      });
      expect(identity).toBeTruthy();
      expect(identity?.assurance).toBe("verified");

      const principal = await started.ctx.repos.principals.getById(
        identity?.principalId ?? "",
      );
      expect(principal?.state).toBe("active");
      expect(principal?.assurance).toBe("verified");

      // The record is in use, which is what the operator surface lists by.
      const record = await started.ctx.repos.byoUpstreams.getById(
        pending?.byoId ?? "",
      );
      expect(record?.lastUsedAt).toBeTruthy();
    }, 30_000);

    /**
     * Account takeover through the bring-your-own form, refused.
     *
     * The verified-email auto-link attaches a new identity to whichever
     * principal already owns the address. That is safe only from an issuer
     * with standing to speak about the address — and a bring-your-own record
     * has none: it is created by an unauthenticated stranger naming a server
     * they control, which is the entire point of the feature.
     *
     * So the attack is cheap. Stand up an OIDC server, register it through
     * the login page with no account at all, and mint an id_token claiming
     * the victim's address is verified. Every signature check passes, because
     * the attacker owns the issuer. Only the authority fence stops the
     * hand-back from completing as the victim.
     */
    it("refuses to hand a visitor's own issuer somebody else's account", async () => {
      // A victim who already exists, with a verified address, exactly as a
      // Google or Entra sign-in would have left them.
      const victimEmail = `victim-${randomBytes(4).toString("hex")}@corp.example`;
      const victim = await started.ctx.repos.principals.create({
        id: `prn_victim_${randomBytes(6).toString("hex")}`,
        state: "active",
        assurance: "verified",
        createdAt: started.ctx.clock(),
        updatedAt: started.ctx.clock(),
        version: 1,
      });
      await started.ctx.repos.externalIdentities.create({
        id: `xid_${randomBytes(8).toString("hex")}`,
        principalId: victim.id,
        kind: "oidc",
        issuer: "https://accounts.google.com",
        subject: `google-${randomBytes(4).toString("hex")}`,
        assurance: "verified",
        linkedAt: started.ctx.clock(),
        metadata: {},
        emailNormalized: victimEmail,
        emailVerified: true,
      });

      // The attacker's issuer asserts the victim's address, verified.
      const attackerSubject = `attacker-${randomBytes(4).toString("hex")}`;
      roundTripIdp.setSubject(attackerSubject);
      roundTripIdp.setEmail(victimEmail, true);
      roundTripIdp.setRedirectUris([stableCallback()]);

      const { jar, uid, html } = await loginPage();
      const start = await req(
        base,
        jar,
        `/interaction/${uid}/federated/byo`,
        postForm({
          _csrf: extractCsrf(html),
          issuer: roundTripIdp.issuer,
          client_id: roundTripIdp.clientId,
          client_secret: roundTripIdp.clientSecret,
        }),
      );
      expect(start.status).toBe(303);
      const authorize = new URL(start.headers.get("location") ?? "");
      const upstream = await fetch(authorize, { redirect: "manual" });
      const back = new URL(upstream.headers.get("location") ?? "");
      const handBack = await req(base, jar, `${back.pathname}${back.search}`);
      const completed = await req(
        base,
        jar,
        handBack.headers.get("location") ?? "",
      );
      // The sign-in itself succeeds — the attacker is entitled to an account.
      expect(completed.status).toBe(303);

      const planted = await started.ctx.repos.externalIdentities.findByTuple({
        kind: "oidc",
        issuer: roundTripIdp.issuer,
        subject: attackerSubject,
      });
      expect(planted).toBeTruthy();

      // ...but it is THEIR account, not the victim's.
      expect(planted?.principalId).not.toBe(victim.id);
      // And the claim was not stored as verified, so it cannot become the
      // target of the victim's next genuinely verified sign-in either.
      expect(planted?.emailVerified).not.toBe(true);

      const victimIdentities =
        await started.ctx.repos.externalIdentities.listByPrincipal(victim.id);
      expect(
        victimIdentities.some((row) => row.issuer === roundTripIdp.issuer),
      ).toBe(false);

      roundTripIdp.setEmail("mock@example.com", true);
    }, 30_000);

    /**
     * The regression the per-interaction callback caused, for the leg that
     * kept it longest.
     *
     * A visitor who brings their own credentials registers one redirect URI at
     * their own IdP, once. Under the old shape the URI named the interaction
     * that happened to be open when they registered it, so their SECOND
     * sign-in — a different interaction, a different path — presented a URI
     * that IdP had never seen and died at the authorize endpoint. The IdP here
     * is configured exactly as a real one would be: one registered URI, never
     * updated between the two visits.
     */
    it("signs the same visitor in again through a second interaction", async () => {
      const subject = `byo-reentry-${randomBytes(4).toString("hex")}`;
      roundTripIdp.setSubject(subject);
      roundTripIdp.setRedirectUris([stableCallback()]);

      // Inferred rather than annotated: the shape is one helper's own.
      async function signIn() {
        const { jar, uid, html } = await loginPage();
        const start = await req(
          base,
          jar,
          `/interaction/${uid}/federated/byo`,
          postForm({
            _csrf: extractCsrf(html),
            issuer: roundTripIdp.issuer,
            client_id: roundTripIdp.clientId,
            client_secret: roundTripIdp.clientSecret,
          }),
        );
        expect(start.status).toBe(303);
        const authorize = new URL(start.headers.get("location") ?? "");
        expect(authorize.searchParams.get("redirect_uri")).toBe(
          stableCallback(),
        );

        // A 302 is the IdP accepting the URI as registered. The old shape
        // reached this line on the first visit and failed here on the second.
        const upstream = await fetch(authorize, { redirect: "manual" });
        expect(upstream.status).toBe(302);
        const back = new URL(upstream.headers.get("location") ?? "");
        const handBack = await req(base, jar, `${back.pathname}${back.search}`);
        expect(handBack.status).toBe(303);
        const completed = await req(
          base,
          jar,
          handBack.headers.get("location") ?? "",
        );
        expect(completed.status).toBe(303);
        return uid;
      }

      const firstUid = await signIn();
      const secondUid = await signIn();
      expect(secondUid).not.toBe(firstUid);

      // And both landed on the one principal: re-entry reuses the record and
      // the tuple, rather than minting a second account for the same human.
      const identity = await started.ctx.repos.externalIdentities.findByTuple({
        kind: "oidc",
        issuer: roundTripIdp.issuer,
        subject,
      });
      expect(identity).toBeTruthy();
      const peers = await started.ctx.repos.externalIdentities.listByPrincipal(
        identity?.principalId ?? "",
      );
      expect(peers.filter((e) => e.subject === subject)).toHaveLength(1);
    }, 30_000);

    /**
     * The same round trip with no client credentials at all: the server
     * registers ITSELF at the visitor's issuer over RFC 7591 and then signs
     * them in as the client that registration minted. Nothing here is
     * simulated — the client id in the authorize URL was issued by the
     * reference IdP's own registration endpoint moments earlier.
     */
    it("registers dynamically and completes the leg as the minted client", async () => {
      const subject = `byo-dcr-${randomBytes(4).toString("hex")}`;
      dcrRoundTripIdp.setSubject(subject);
      const { jar, uid, html } = await loginPage();

      const start = await req(
        base,
        jar,
        `/interaction/${uid}/federated/byo`,
        // Exactly what the rendered form posts when the visitor leaves the
        // client fields empty: present, and blank.
        postForm({
          _csrf: extractCsrf(html),
          issuer: dcrRoundTripIdp.issuer,
          client_id: "",
          client_secret: "",
        }),
      );
      expect(start.status).toBe(303);
      const authorize = new URL(start.headers.get("location") ?? "");
      expect(authorize.origin).toBe(dcrRoundTripIdp.issuer);
      expect(authorize.searchParams.get("client_id")).toMatch(/^dcr-/);

      const upstreamRes = await fetch(authorize, { redirect: "manual" });
      const back = new URL(upstreamRes.headers.get("location") ?? "");
      const completed = await req(
        base,
        jar,
        `/interaction/${uid}/federated/callback${back.search}`,
      );
      expect(completed.status).toBe(303);

      const identity = await started.ctx.repos.externalIdentities.findByTuple({
        kind: "oidc",
        issuer: dcrRoundTripIdp.issuer,
        subject,
      });
      expect(identity?.assurance).toBe("verified");
      const principal = await started.ctx.repos.principals.getById(
        identity?.principalId ?? "",
      );
      expect(principal?.state).toBe("active");
      expect(principal?.assurance).toBe("verified");

      // The credential the leg just used came from the registration, and it
      // is durable — this is what a returning visitor signs in with.
      const record = await started.ctx.repos.byoUpstreams.findByIssuer(
        dcrRoundTripIdp.issuer,
      );
      expect(record?.registrationSource).toBe("dcr");
      expect(record?.clientAuth).toBe("client_secret_post");
      expect(record?.clientId).toBe(authorize.searchParams.get("client_id"));
    }, 30_000);

    /**
     * The whole point of the stable callback (ADR 0055): the SECOND sign-in.
     *
     * RFC 7591 registers one redirect_uri, and the reference IdP — like most
     * real ones — matches it exactly (`redirectAllowedForConfidential`). When
     * that URI named the interaction it was registered from, the first sign-in
     * worked and every later one died at `/authorize` with
     * `invalid_redirect_uri`, because tomorrow's interaction has a different
     * uid. Here both sign-ins quote the same deployment-wide URL, and the
     * second one resolves to the principal the first one created.
     */
    it("signs the same visitor in again on a later interaction", async () => {
      const subject = `byo-reentry-${randomBytes(4).toString("hex")}`;
      dcrReentryIdp.setSubject(subject);

      // Inferred rather than annotated: the shape is one helper's own.
      async function signIn() {
        const { jar, uid, html } = await loginPage();
        const start = await req(
          base,
          jar,
          `/interaction/${uid}/federated/byo`,
          postForm({
            _csrf: extractCsrf(html),
            issuer: dcrReentryIdp.issuer,
            client_id: "",
            client_secret: "",
          }),
        );
        expect(start.status).toBe(303);
        const authorize = new URL(start.headers.get("location") ?? "");
        // Deployment-wide, and deliberately naming no interaction: this is the
        // URI the registration handed the IdP, on both visits.
        expect(authorize.searchParams.get("redirect_uri")).toBe(
          stableCallback(),
        );
        // `state` carries the interaction so the shared callback knows which
        // one to hand the browser back to, and stays the binding openid-client
        // compares byte for byte against the pending cookie.
        expect(authorize.searchParams.get("state")).toMatch(
          new RegExp(`^${uid}\\..+`),
        );

        // A 302 here is the IdP accepting the redirect_uri as registered; the
        // per-interaction URI it never saw would be a 400 instead.
        const upstream = await fetch(authorize, { redirect: "manual" });
        expect(upstream.status).toBe(302);
        const back = new URL(upstream.headers.get("location") ?? "");
        expect(back.href.startsWith(stableCallback())).toBe(true);

        // The shared callback completes nothing: it 303s to a top-level GET
        // under /interaction/<uid>, which is where the Lax interaction cookie
        // lives, and that request finishes the leg.
        const handBack = await req(base, jar, `${back.pathname}${back.search}`);
        expect(handBack.status).toBe(303);
        const resume = handBack.headers.get("location") ?? "";
        expect(
          resume.startsWith(`/interaction/${uid}/federated/callback?`),
        ).toBe(true);

        const completed = await req(base, jar, resume);
        expect(completed.status).toBe(303);
        expect(completed.headers.get("location")).toContain("/auth/");
        return { uid, jar };
      }

      const first = await signIn();
      const identity = await started.ctx.repos.externalIdentities.findByTuple({
        kind: "oidc",
        issuer: dcrReentryIdp.issuer,
        subject,
      });
      expect(identity?.assurance).toBe("verified");
      const principal = await started.ctx.repos.principals.getById(
        identity?.principalId ?? "",
      );
      expect(principal?.state).toBe("active");

      const second = await signIn();
      expect(second.uid).not.toBe(first.uid);

      // ONE canonical principal across both sign-ins — the second visit found
      // the identity row rather than minting a second account beside it.
      const after = await started.ctx.repos.externalIdentities.findByTuple({
        kind: "oidc",
        issuer: dcrReentryIdp.issuer,
        subject,
      });
      expect(after?.principalId).toBe(identity?.principalId);
      // A returning identity gets no fresh provisional session (T6).
      expect(second.jar.get("os_provisional")).toBeFalsy();

      // Still one record, reused by issuer rather than re-registered.
      const record = await started.ctx.repos.byoUpstreams.findByIssuer(
        dcrReentryIdp.issuer,
      );
      expect(record?.registrationSource).toBe("dcr");
      expect(record?.lastUsedAt).toBeTruthy();
    }, 45_000);
  });
});
