import {
  type ReferenceIdp,
  type SamlMutation,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  resetSamlCompletionCodes,
  resetSamlMetadataCache,
} from "../interactions/saml.js";
import type { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";
import { hopUrl } from "./upstream-hop.js";

/**
 * What the SAML SP refuses (T26 / D10).
 *
 * Every malformation below is produced by the reference IdP's own signing
 * machinery — real XML-DSig over a real runtime keypair, mutated at the point
 * a real attacker would have to mutate it. Nothing here is a hand-built
 * string, because a hand-built string proves only that the parser rejects
 * hand-built strings.
 *
 * The suite is deliberately paranoid about ONE thing: every refusal must be
 * the same refusal. The ACS is unauthenticated, so a bad signature answering
 * differently from an unknown request, or from an assertion already spent,
 * would hand a stranger a map of this server's state.
 */

type Started = Awaited<ReturnType<typeof startServer>>;
type PostBindingForm = { action: string; fields: AcsFormFields };
/** Exactly what the IdP's POST-binding form carries to the ACS. */
type AcsFormFields = { SAMLResponse?: string; RelayState?: string };
type LoginPage = { jar: Jar; uid: string; html: string };
type StartedSamlLeg = { jar: Jar; uid: string; binding: PostBindingForm };

const RP_ORIGIN = "http://127.0.0.1:4332";
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

function decodeHtml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
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

/** Drive an SP-initiated leg up to (but not through) the ACS. */
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
  const idpRes = await fetch(await hopUrl(start), {
    redirect: "manual",
  });
  return { jar, uid, binding: parsePostBinding(await idpRes.text()) };
}

/** Post to the ACS the way a browser does: with NO cookies (T25). */
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

describe("SAML assertion validation", () => {
  let idp: ReferenceIdp;
  let started: Started;
  let base: string;
  let acsUrl: string;
  const organizationId = "org_saml_security";

  beforeAll(async () => {
    resetSamlMetadataCache();
    resetSamlCompletionCodes();
    idp = await startReferenceIdp({ protocol: "saml" });
    started = await onFreePort((port) => startControlPlane(idp.issuer, port));
    base = `http://127.0.0.1:${started.port}`;
    acsUrl = `${base}/v1/saml/acs`;
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

  afterEach(() => {
    idp.saml.setMutation(undefined);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await idp.close();
    resetSamlMetadataCache();
    resetSamlCompletionCodes();
  });

  /**
   * The whole T26 set, SP-initiated: a valid pending record exists and the
   * response answers it, so the ONLY thing standing between each of these and
   * a signed-in session is the assertion check that refuses it.
   */
  it.each<[string, SamlMutation]>([
    ["an unsigned assertion", "unsigned"],
    ["a signature over the wrong element", "wrong-element"],
    ["a signature-wrapped evil assertion", "wrapped"],
    ["an audience naming another service provider", "wrong-audience"],
    ["conditions that already expired", "expired"],
    ["conditions that are not yet valid", "future"],
  ])(
    "refuses %s",
    async (_label, mutation) => {
      idp.saml.setMutation(mutation);
      const { binding } = await runSamlLegToPostBinding(base, "acme");
      const res = await postAcsCookieless(acsUrl, {
        SAMLResponse: binding.fields.SAMLResponse ?? "",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("That sign-in could not be completed.");
      expect(res.headers.getSetCookie()).toHaveLength(0);
    },
    30_000,
  );

  it("mints no principal for a rejected assertion", async () => {
    const subject = `saml-rejected-${Date.now()}`;
    idp.setSubject(subject);
    idp.saml.setMutation("wrapped");
    const { binding } = await runSamlLegToPostBinding(base, "acme");
    await postAcsCookieless(acsUrl, {
      SAMLResponse: binding.fields.SAMLResponse ?? "",
    });
    // The wrapped variant carries `attacker@evil.example` as the NameID of the
    // assertion a naive validator would read. Neither subject exists.
    for (const candidate of [subject, "attacker@evil.example"]) {
      expect(
        await started.ctx.repos.externalIdentities.findByTuple({
          kind: "saml",
          issuer: idp.saml.entityId,
          subject: candidate,
        }),
      ).toBeNull();
    }
  }, 30_000);

  it("refuses a response quoting an InResponseTo it never issued", async () => {
    idp.setSubject(`saml-unknown-${Date.now()}`);
    const { binding } = await runSamlLegToPostBinding(base, "acme");
    const samlResponse = binding.fields.SAMLResponse ?? "";

    // The first delivery consumes the pending record — it is single-use in the
    // store by construction — so the second quotes a request id this server no
    // longer has, which is exactly the shape of a forged InResponseTo.
    expect(
      (await postAcsCookieless(acsUrl, { SAMLResponse: samlResponse })).status,
    ).toBe(303);
    const replay = await postAcsCookieless(acsUrl, {
      SAMLResponse: samlResponse,
    });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toBe("That sign-in could not be completed.");
  }, 30_000);

  it("refuses an SP-bound assertion re-posted as IdP-initiated", async () => {
    idp.setSubject(`saml-rebind-${Date.now()}`);
    const { binding } = await runSamlLegToPostBinding(base, "acme");
    const samlResponse = binding.fields.SAMLResponse ?? "";
    const xml = Buffer.from(samlResponse, "base64").toString("utf8");
    // Strip the wrapper's InResponseTo — it is not covered by the assertion
    // signature, so an attacker can. The signed copy inside
    // SubjectConfirmationData is what refuses this.
    const stripped = xml.replace(/ InResponseTo="[^"]*"(?![^<]*Recipient)/, "");
    const res = await postAcsCookieless(acsUrl, {
      SAMLResponse: Buffer.from(stripped, "utf8").toString("base64"),
    });
    expect(res.status).toBe(400);
  }, 30_000);

  it("refuses an empty or unparseable SAMLResponse", async () => {
    for (const SAMLResponse of ["", "not-base64-xml", "PHhtbC8+"]) {
      const res = await postAcsCookieless(acsUrl, { SAMLResponse });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("That sign-in could not be completed.");
    }
  }, 30_000);
});

describe("SAML IdP-initiated sign-in", () => {
  let idp: ReferenceIdp;
  let started: Started;
  let base: string;
  let acsUrl: string;
  const organizationId = "org_saml_idp_init";

  beforeAll(async () => {
    resetSamlMetadataCache();
    resetSamlCompletionCodes();
    idp = await startReferenceIdp({ protocol: "saml" });
    started = await onFreePort((port) => startControlPlane(idp.issuer, port));
    base = `http://127.0.0.1:${started.port}`;
    acsUrl = `${base}/v1/saml/acs`;
    const now = started.ctx.clock();
    await started.ctx.stores.organizations.set(organizationId, {
      id: organizationId,
      slug: "beta",
      displayName: "Beta",
      state: "active",
      createdBy: "prn_seed_owner",
      createdAt: now,
      updatedAt: now,
      // The entityID is what routes an unsolicited response to this tenant —
      // there is no request to match it against.
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

  it("admits the subject, joins the tenant, and audits the flow", async () => {
    const subject = `saml-idp-${Date.now()}`;
    const posted = await idp.idpInitiatedSamlPost(acsUrl, { subject });
    const res = await postAcsCookieless(acsUrl, posted);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const jar = new Jar();
    jar.absorb(res);
    expect(jar.get(started.ctx.config.provisionalCookieName)).toBeTruthy();

    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "saml",
      issuer: idp.saml.entityId,
      subject,
    });
    expect(identity).toBeTruthy();

    const membership = await started.ctx.stores.organizationMemberships.find(
      organizationId,
      identity?.principalId ?? "",
    );
    expect(membership?.role).toBe("member");

    const events = await started.ctx.repos.auditEvents.list({ limit: 100 });
    const audited = events.find(
      (event) =>
        event.eventType === "principal.saml_idp_initiated" &&
        event.principalId === identity?.principalId,
    );
    expect(audited?.organizationId).toBe(organizationId);
    expect(audited?.metadata).toMatchObject({ issuer: idp.saml.entityId });
  }, 30_000);

  it("refuses a re-posted assertion id", async () => {
    const assertionId = `_replay${Date.now()}`;
    const subject = `saml-replay-${Date.now()}`;
    const posted = await idp.idpInitiatedSamlPost(acsUrl, {
      subject,
      assertionId,
    });
    expect((await postAcsCookieless(acsUrl, posted)).status).toBe(303);

    // Byte-identical, signature and all: the assertion is perfectly valid and
    // must still be refused, because it has already been spent.
    const replay = await postAcsCookieless(acsUrl, posted);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toBe("That sign-in could not be completed.");
    expect(replay.headers.getSetCookie()).toHaveLength(0);
  }, 30_000);

  it("honours a same-origin RelayState path", async () => {
    const posted = await idp.idpInitiatedSamlPost(acsUrl, {
      subject: `saml-relay-${Date.now()}`,
      relayState: "/dashboard?tab=apps",
    });
    const res = await postAcsCookieless(acsUrl, posted);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard?tab=apps");
  }, 30_000);

  it("lands on the default page for a hostile RelayState", async () => {
    for (const relayState of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "javascript:alert(1)",
    ]) {
      const posted = await idp.idpInitiatedSamlPost(acsUrl, {
        subject: `saml-hostile-${Date.now()}-${relayState.length}`,
        relayState,
      });
      const res = await postAcsCookieless(acsUrl, posted);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    }
  }, 30_000);

  it("refuses an audience naming somebody else's service provider", async () => {
    const posted = await idp.idpInitiatedSamlPost(acsUrl, {
      subject: `saml-aud-${Date.now()}`,
      audience: "https://other-sp.example/v1/saml/metadata",
    });
    const res = await postAcsCookieless(acsUrl, posted);
    expect(res.status).toBe(400);
  }, 30_000);

  it("refuses an issuer no organization on this server configured", async () => {
    const stranger = await startReferenceIdp({ protocol: "saml" });
    try {
      const posted = await stranger.idpInitiatedSamlPost(acsUrl, {
        subject: "outsider",
        // Correctly addressed to us, correctly signed — by the wrong IdP.
        audience: `${base}/v1/saml/metadata`,
      });
      const res = await postAcsCookieless(acsUrl, posted);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("That sign-in could not be completed.");
    } finally {
      await stranger.close();
    }
  }, 30_000);
});
