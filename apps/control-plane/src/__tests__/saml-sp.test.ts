import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  resetSamlCompletionCodes,
  resetSamlMetadataCache,
  samlRelayPath,
  samlServiceProviderMetadata,
} from "../interactions/saml.js";
import type { startServer } from "../server.js";
import { hopUrl } from "./upstream-hop.js";

/**
 * Native SAML SP, end to end against the reference IdP (C14 / ADR 0056).
 *
 * The counterparty is a real SAML identity provider signing real XML-DSig over
 * a keypair it generates at startup — the same server the dev stack runs. No
 * assertion in this file was hand-assembled, which is the only way the
 * signature checks below mean anything.
 */

type Started = Awaited<ReturnType<typeof startServer>>;
type PostBindingForm = { action: string; fields: AcsFormFields };
/** Exactly what the IdP's POST-binding form carries to the ACS. */
type AcsFormFields = { SAMLResponse?: string; RelayState?: string };
type LoginPage = { jar: Jar; uid: string; html: string };
type StartedSamlLeg = { jar: Jar; uid: string; binding: PostBindingForm };

const RP_ORIGIN = "http://127.0.0.1:4331";
const RP_CLIENT_ID = `origin:${RP_ORIGIN}`;
const RP_REDIRECT = `${RP_ORIGIN}/opensesame/callback`;

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
      // publicUrl must match the real bound port: it is the SP entityID, the
      // ACS the AuthnRequest names, and the origin-profile client id.
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

/** The hidden inputs of the IdP's HTTP-POST binding document. */
function parsePostBinding(html: string): PostBindingForm {
  const action = html.match(/<form[^>]+action="([^"]+)"/)?.[1] ?? "";
  const fields: AcsFormFields = {};
  for (const input of html.matchAll(/<input[^>]*>/g)) {
    const name = input[0].match(/name="([^"]+)"/)?.[1];
    const value = input[0].match(/value="([^"]*)"/)?.[1];
    if (name === "SAMLResponse") fields.SAMLResponse = decodeHtml(value ?? "");
    if (name === "RelayState") fields.RelayState = decodeHtml(value ?? "");
  }
  return { action, fields };
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

async function openLoginPage(base: string): Promise<LoginPage> {
  const jar = new Jar();
  const res = await req(
    base,
    jar,
    `/auth?${new URLSearchParams({
      client_id: RP_CLIENT_ID,
      redirect_uri: RP_REDIRECT,
      response_type: "code",
      scope: "openid",
      state: "s-1",
      nonce: "n-1",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    }).toString()}`,
  );
  const location = res.headers.get("location") ?? "";
  const page = await req(base, jar, location);
  return {
    jar,
    uid: location.slice("/interaction/".length),
    html: await page.text(),
  };
}

/**
 * Drive an SP-initiated leg up to (but not through) the ACS.
 *
 * Returns what the IdP would have made the browser POST, so the caller can
 * decide how to deliver it — which is the point of separating this out: the
 * ACS POST in a real flow carries no cookies at all (T25).
 */
async function runSamlLegToPostBinding(
  base: string,
  slug: string,
): Promise<StartedSamlLeg> {
  const { jar, uid, html } = await openLoginPage(base);
  const start = await req(base, jar, `/interaction/${uid}/federated/saml`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: extractCsrf(html), slug }),
  });
  const authnRequestUrl = await hopUrl(start);
  const idpRes = await fetch(authnRequestUrl, { redirect: "manual" });
  return { jar, uid, binding: parsePostBinding(await idpRes.text()) };
}

/** Post an assertion to the ACS the way a browser does: with NO cookies (T25). */
async function postAcsCookieless(
  acsUrl: string,
  fields: AcsFormFields,
): Promise<Response> {
  const body = new URLSearchParams({ SAMLResponse: fields.SAMLResponse ?? "" });
  if (fields.RelayState !== undefined)
    body.set("RelayState", fields.RelayState);
  return fetch(acsUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("SP metadata document", () => {
  it("names the ACS and entityID this deployment publishes", () => {
    const xml = samlServiceProviderMetadata(
      overlapCast({ publicUrl: "https://id.example.com" }),
    );
    expect(xml).toContain('entityID="https://id.example.com/v1/saml/metadata"');
    expect(xml).toContain('Location="https://id.example.com/v1/saml/acs"');
    expect(xml).toContain(
      'Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"',
    );
    // No signing key is held, so claiming signed AuthnRequests would make
    // every IdP that honours the flag reject ours.
    expect(xml).toContain('AuthnRequestsSigned="false"');
    expect(xml).toContain('WantAssertionsSigned="true"');
  });

  it("is byte-stable across reads", () => {
    const config = overlapCast({ publicUrl: "https://id.example.com/" });
    expect(samlServiceProviderMetadata(config)).toBe(
      samlServiceProviderMetadata(config),
    );
  });

  it("matches its characterization snapshot", () => {
    expect(
      samlServiceProviderMetadata(
        overlapCast({ publicUrl: "https://id.example.com" }),
      ),
    ).toMatchSnapshot();
  });
});

describe("RelayState policy", () => {
  const config = overlapCast({ publicUrl: "https://id.example.com" });

  it.each([
    ["absent", undefined, "/"],
    ["a same-origin path", "/dashboard?x=1", "/dashboard?x=1"],
    ["an absolute same-origin URL", "https://id.example.com/x", "/x"],
    ["an absolute foreign URL", "https://evil.example/x", "/"],
    ["a protocol-relative host", "//evil.example/x", "/"],
    ["a scheme downgrade", "http://id.example.com/x", "/"],
    ["nonsense", "::::", "/"],
  ])("resolves %s to %s", (_label, relayState, expected) => {
    expect(samlRelayPath(config, relayState)).toBe(expected);
  });
});

describe("native SAML SP, SP-initiated", () => {
  let idp: ReferenceIdp;
  let started: Started;
  let base: string;
  const organizationId = "org_saml_sp";

  beforeAll(async () => {
    resetSamlMetadataCache();
    resetSamlCompletionCodes();
    idp = await startReferenceIdp({ protocol: "saml" });
    started = await startControlPlane(idp.issuer, await reservePort());
    base = `http://127.0.0.1:${started.port}`;
    const now = started.ctx.clock();
    await started.ctx.stores.organizations.set(organizationId, {
      id: organizationId,
      slug: "acme",
      displayName: "Acme",
      state: "active",
      createdBy: "prn_seed_owner",
      createdAt: now,
      updatedAt: now,
      samlIssuer: idp.saml.entityId,
      samlMetadataUrl: idp.saml.metadataUrl,
    });
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await idp.close();
    resetSamlMetadataCache();
    resetSamlCompletionCodes();
  });

  it("serves SP metadata naming its own ACS", async () => {
    const res = await fetch(`${base}/v1/saml/metadata`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("samlmetadata+xml");
    const xml = await res.text();
    expect(xml).toContain(`entityID="${base}/v1/saml/metadata"`);
    expect(xml).toContain(`Location="${base}/v1/saml/acs"`);
  });

  it("addresses the AuthnRequest to the IdP and keeps its state server-side", async () => {
    const { jar, uid, html } = await openLoginPage(base);
    const start = await req(base, jar, `/interaction/${uid}/federated/saml`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: extractCsrf(html), slug: "acme" }),
    });
    const target = new URL(await hopUrl(start));
    expect(`${target.origin}${target.pathname}`).toBe(idp.saml.ssoRedirectUrl);
    expect(target.searchParams.get("SAMLRequest")).toBeTruthy();
    // T25: nothing about this leg is in a cookie. The only thing the browser
    // carries is the interaction cookie it already had.
    for (const cookie of start.headers.getSetCookie()) {
      expect(cookie).not.toMatch(/saml/i);
    }
  }, 30_000);

  it("signs a new principal in through a cookie-less ACS POST", async () => {
    const subject = `saml-user-${Date.now()}`;
    idp.setSubject(subject);
    const { jar, uid, binding } = await runSamlLegToPostBinding(base, "acme");
    expect(binding.action).toBe(`${base}/v1/saml/acs`);

    // The real thing: the IdP's browser POST is cross-site and carries no
    // `SameSite=Lax` cookie. Sending the jar here would prove nothing.
    const acs = await postAcsCookieless(binding.action, {
      SAMLResponse: binding.fields.SAMLResponse ?? "",
    });
    expect(acs.status).toBe(303);
    const completeUrl = acs.headers.get("location") ?? "";
    expect(completeUrl).toContain(
      `/interaction/${uid}/federated/saml/complete?otc=`,
    );
    // Nothing was signed in at the ACS: it has no interaction to finish.
    expect(acs.headers.getSetCookie()).toHaveLength(0);

    // ...and the top-level GET, which does carry the interaction cookie, is
    // where the interaction actually completes.
    const complete = await req(base, jar, completeUrl);
    expect(complete.status).toBe(303);
    expect(complete.headers.get("location")).toContain("/auth/");
    expect(jar.get(started.ctx.config.provisionalCookieName)).toBeTruthy();

    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "saml",
      issuer: idp.saml.entityId,
      subject,
    });
    expect(identity).toBeTruthy();
    expect(identity?.assurance).toBe("verified");
    // The NameID Format is provenance on the row, not a claim about the human.
    expect(identity?.metadata).toMatchObject({
      nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    });

    const principal = await started.ctx.repos.principals.getById(
      identity?.principalId ?? "",
    );
    expect(principal?.state).toBe("active");
    expect(principal?.assurance).toBe("verified");

    const membership = await started.ctx.stores.organizationMemberships.find(
      organizationId,
      identity?.principalId ?? "",
    );
    expect(membership?.role).toBe("member");
  }, 30_000);

  /**
   * Whether an assertion's email may act as a linking key (ADR 0057).
   *
   * SAML has no `email_verified`, so for a long time the attribute was carried
   * as a display hint and nothing else — which meant somebody who signed in
   * with Google at work and then through their employer's SAML IdP quietly got
   * two accounts. The attribute does have provenance: the tenant's own IdP set
   * it, inside an assertion this server verified. What it lacks is any bound
   * on WHICH addresses that tenant may speak for, and an owner who could
   * assert `someone-else@gmail.com` would walk straight onto that person's
   * principal.
   *
   * The DNS-TXT domain proof is that bound, and it is the same one the
   * directory leg already uses.
   */
  describe("an assertion's email as a linking key", () => {
    /** Drive one full SP-initiated sign-in and return the identity row. */
    async function signIn(subject: string) {
      idp.setSubject(subject);
      const { jar, binding } = await runSamlLegToPostBinding(base, "acme");
      const acs = await postAcsCookieless(binding.action, {
        SAMLResponse: binding.fields.SAMLResponse ?? "",
      });
      expect(acs.status).toBe(303);
      const complete = await req(base, jar, acs.headers.get("location") ?? "");
      expect(complete.status).toBe(303);
      return started.ctx.repos.externalIdentities.findByTuple({
        kind: "saml",
        issuer: idp.saml.entityId,
        subject,
      });
    }

    afterEach(async () => {
      await started.ctx.stores.orgFederation.emailDomains.remove(
        organizationId,
        "example.com",
      );
    });

    it("counts it verified for a domain the organization proved", async () => {
      await started.ctx.stores.orgFederation.emailDomains.claim({
        organizationId,
        domain: "example.com",
        verificationToken: "tok-saml-verified",
      });
      await started.ctx.stores.orgFederation.emailDomains.markVerified(
        "example.com",
        started.ctx.clock(),
      );

      const identity = await signIn(`saml-domain-ok-${Date.now()}`);
      expect(identity?.emailNormalized).toBe("mock@example.com");
      expect(identity?.emailVerified).toBe(true);
    }, 30_000);

    it("refuses it for a domain claimed but never proved", async () => {
      // A claim is a statement of intent; the TXT record is the proof. Acting
      // on the claim alone would make the whole check ceremonial.
      await started.ctx.stores.orgFederation.emailDomains.claim({
        organizationId,
        domain: "example.com",
        verificationToken: "tok-saml-unverified",
      });

      const identity = await signIn(`saml-domain-unverified-${Date.now()}`);
      expect(identity?.emailNormalized).toBeUndefined();
      expect(identity?.emailVerified).toBeFalsy();
    }, 30_000);

    it("refuses it for a domain a different organization proved", async () => {
      // Another tenant's proof says nothing about what this one may assert.
      // Borrowing it would make every verified domain a shared credential.
      const other = "org_saml_other_tenant";
      const now = started.ctx.clock();
      await started.ctx.stores.organizations.set(other, {
        id: other,
        slug: "other",
        displayName: "Other",
        state: "active",
        createdBy: "prn_seed_owner",
        createdAt: now,
        updatedAt: now,
      });
      await started.ctx.stores.orgFederation.emailDomains.claim({
        organizationId: other,
        domain: "example.com",
        verificationToken: "tok-saml-other",
      });
      await started.ctx.stores.orgFederation.emailDomains.markVerified(
        "example.com",
        now,
      );

      const identity = await signIn(`saml-domain-foreign-${Date.now()}`);
      expect(identity?.emailNormalized).toBeUndefined();
      expect(identity?.emailVerified).toBeFalsy();

      await started.ctx.stores.orgFederation.emailDomains.remove(
        other,
        "example.com",
      );
    }, 30_000);
  });

  it("spends a completion code exactly once", async () => {
    idp.setSubject(`saml-once-${Date.now()}`);
    const { jar, binding } = await runSamlLegToPostBinding(base, "acme");
    const acs = await postAcsCookieless(binding.action, {
      SAMLResponse: binding.fields.SAMLResponse ?? "",
    });
    const completeUrl = acs.headers.get("location") ?? "";
    expect((await req(base, jar, completeUrl)).status).toBe(303);
    // The interaction is finished, but the code is what is being tested: a
    // second GET must find nothing to spend.
    const replay = await req(base, new Jar(), completeUrl);
    expect(replay.status).not.toBe(303);
  }, 30_000);

  it("returns the same principal on a second sign-in", async () => {
    const subject = `saml-return-${Date.now()}`;
    idp.setSubject(subject);

    const first = await runSamlLegToPostBinding(base, "acme");
    const firstAcs = await postAcsCookieless(first.binding.action, {
      SAMLResponse: first.binding.fields.SAMLResponse ?? "",
    });
    await req(base, first.jar, firstAcs.headers.get("location") ?? "");

    const second = await runSamlLegToPostBinding(base, "acme");
    const secondAcs = await postAcsCookieless(second.binding.action, {
      SAMLResponse: second.binding.fields.SAMLResponse ?? "",
    });
    const complete = await req(
      base,
      second.jar,
      secondAcs.headers.get("location") ?? "",
    );
    expect(complete.status).toBe(303);
    // T6: a returning identity gets no fresh provisional cookie — it already
    // is somebody, and minting a second session here would make it two.
    expect(
      second.jar.get(started.ctx.config.provisionalCookieName),
    ).toBeUndefined();

    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "saml",
      issuer: idp.saml.entityId,
      subject,
    });
    expect(identity).toBeTruthy();
  }, 30_000);

  it("gives one uniform answer for a slug it cannot start", async () => {
    const { jar, uid, html } = await openLoginPage(base);
    const res = await req(base, jar, `/interaction/${uid}/federated/saml`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: extractCsrf(html),
        slug: "no-such-tenant",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("not available right now");
    // T13: the verify above consumed the token, so the re-render must carry a
    // fresh one or the user's next submit 403s.
    expect(extractCsrf(body)).not.toBe(extractCsrf(html));
  }, 30_000);

  it("refuses a start without the synchronizer token", async () => {
    const { jar, uid } = await openLoginPage(base);
    const res = await req(base, jar, `/interaction/${uid}/federated/saml`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ slug: "acme" }),
    });
    expect(res.status).toBe(403);
  }, 30_000);
});
