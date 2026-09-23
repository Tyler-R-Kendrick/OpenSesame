import { randomUUID } from "node:crypto";
import { SignJWT, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { registerByoUpstream, resetByoBudget } from "../interactions/byo.js";
import { upstreamFetch } from "../interactions/federated-fetch.js";
import { fencedLdapTarget } from "../interactions/ldap-host-guard.js";
import { resetBackchannelLogoutBudget } from "../routes/backchannel-logout.js";
import {
  type PinnedRequest,
  UnsafeUpstreamError,
  guardedFetch,
  guardedFetchSeams,
} from "../services/guarded-fetch.js";

/**
 * The DNS half of the SSRF fence (T21).
 *
 * A URL guard that reads only the hostname as written is walked past by a
 * public name whose DNS answer is private, and by a discovery document that
 * simply names a private `jwks_uri`. Every case here runs with dev defaults
 * OFF, stubs only DNS and the wire (`guardedFetchSeams`), and asserts on what
 * would actually have been dialled.
 */

const PUBLIC_ADDRESS = "93.184.216.34";
const BYO_ISSUER = "https://idp.byo-fence.test";

const originalSeams = { ...guardedFetchSeams };
let dialled: PinnedRequest[] = [];
let documents: Map<string, unknown>;

/** Stubbed DNS: which address each test hostname answers with. */
type HostAnswers = ReadonlyMap<string, string>;

function answer(map: HostAnswers) {
  guardedFetchSeams.lookup = async (hostname) => {
    const address = map.get(hostname);
    if (!address) throw new Error(`no stub for ${hostname}`);
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
}

beforeEach(() => {
  dialled = [];
  documents = new Map();
  resetBackchannelLogoutBudget();
  resetByoBudget();
  guardedFetchSeams.transport = async (request) => {
    dialled.push(request);
    const body = documents.get(request.url.href);
    return body === undefined
      ? new Response("{}", { status: 404 })
      : Response.json(body);
  };
});

afterEach(() => {
  Object.assign(guardedFetchSeams, originalSeams);
  vi.unstubAllGlobals();
  resetBackchannelLogoutBudget();
  resetByoBudget();
});

function productionPlane() {
  const pepper = "prod-claim-pepper-for-test-only";
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      allowDevDefaults: false,
      claimPepper: pepper,
      isProduction: false,
    },
    processEnv: {
      ...process.env,
      OPENSESAME_ALLOW_DEV_DEFAULTS: "0",
      OPENSESAME_CLAIM_PEPPER: pepper,
      NODE_ENV: "development",
    },
  });
}

async function logoutToken(issuer: string): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256");
  return new SignJWT({
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setSubject("victim")
    .setAudience("anyone")
    .setIssuedAt()
    .setJti(randomUUID())
    .sign(privateKey);
}

describe("backchannel logout against a BYO issuer", () => {
  it.each([
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1:8787/api/v1/operator"],
    ["a public name answering privately", "https://keys.byo-fence.test/jwks"],
  ])("never fetches a jwks_uri at %s", async (_label, jwksUri) => {
    answer(
      new Map([
        ["idp.byo-fence.test", PUBLIC_ADDRESS],
        ["keys.byo-fence.test", "10.0.0.1"],
      ]),
    );
    const plainFetch = vi.fn(() => Promise.resolve(Response.json({})));
    vi.stubGlobal("fetch", plainFetch);
    const { app, ctx } = productionPlane();
    await ctx.repos.byoUpstreams.create({
      id: `byo_${randomUUID()}`,
      issuer: BYO_ISSUER,
      label: "idp.byo-fence.test",
      clientId: "byo-client",
      clientAuth: "none",
      registrationSource: "manual",
      state: "active",
      createdAt: new Date(),
    });
    documents.set(`${BYO_ISSUER}/.well-known/openid-configuration`, {
      issuer: BYO_ISSUER,
      jwks_uri: jwksUri,
    });

    const res = await app.request("/v1/federated/backchannel-logout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        logout_token: await logoutToken(BYO_ISSUER),
      }).toString(),
    });

    expect(res.status).toBe(400);
    // Discovery was the only thing dialled, and it went to the public address.
    expect(dialled.map((request) => request.url.href)).toEqual([
      `${BYO_ISSUER}/.well-known/openid-configuration`,
    ]);
    expect(dialled[0]?.address).toBe(PUBLIC_ADDRESS);
    expect(plainFetch).not.toHaveBeenCalled();
  });
});

describe("BYO registration discovery", () => {
  it("refuses an issuer whose name resolves to a private address", async () => {
    answer(new Map([["idp.rebind.test", "10.0.0.1"]]));
    const { ctx } = productionPlane();
    const outcome = await registerByoUpstream(
      ctx,
      { issuer: "https://idp.rebind.test", clientId: "brought-my-own" },
      "fp-dns-fence",
    );
    expect(outcome).toEqual({
      error: "invalid_issuer",
      message: expect.stringContaining("cannot be used"),
    });
    expect(dialled).toEqual([]);
    expect(
      await ctx.repos.byoUpstreams.findByIssuer("https://idp.rebind.test"),
    ).toBeNull();
  });
});

describe("guardedFetch", () => {
  it("pins a public answer and keeps the name as Host", async () => {
    answer(new Map([["metadata.fence.test", PUBLIC_ADDRESS]]));
    documents.set("https://metadata.fence.test/doc", { ok: true });
    const res = await guardedFetch("https://metadata.fence.test/doc", true);
    expect(await res.json()).toEqual({ ok: true });
    expect(dialled[0]?.address).toBe(PUBLIC_ADDRESS);
    expect(dialled[0]?.url.host).toBe("metadata.fence.test");
  });

  it.each([
    ["10.0.0.1"],
    ["169.254.169.254"],
    ["127.0.0.1"],
    ["::ffff:192.168.1.1"],
  ])("refuses a name that resolves to %s", async (address) => {
    answer(new Map([["rebind.fence.test", address]]));
    await expect(
      guardedFetch("https://rebind.fence.test/x", true),
    ).rejects.toBeInstanceOf(UnsafeUpstreamError);
    expect(dialled).toEqual([]);
  });

  it("fences every request openid-client makes for a BYO or org issuer", async () => {
    answer(new Map([["idp.rebind.test", "10.0.0.1"]]));
    const { config } = productionPlane();
    const fetchFor = upstreamFetch(config, {
      originProfile: false,
      fenced: true,
    });
    await expect(
      fetchFor("https://idp.rebind.test/token", {
        body: "grant_type=authorization_code",
        headers: {},
        method: "POST",
        redirect: "manual",
      }),
    ).rejects.toBeInstanceOf(UnsafeUpstreamError);
    expect(dialled).toEqual([]);
  });
});

describe("LDAP connect-time fence", () => {
  it("refuses to dial a directory name that resolves privately", async () => {
    answer(new Map([["dir.rebind.test", "169.254.169.254"]]));
    const target = fencedLdapTarget(false, {
      organizationId: "org:fence",
      url: "ldaps://dir.rebind.test",
      bindMode: "bind_template",
      bindTemplate: "uid={username},dc=example",
      subjectAttribute: "entryUUID",
      attributeMap: {},
      groupRoleMap: {},
    });
    const connect = target.connections?.createConnection;
    expect(connect).toBeDefined();
    const socket = connect?.(636, "dir.rebind.test");
    const failure = await new Promise<Error>((resolve) =>
      socket?.once("error", resolve),
    );
    expect(failure.message).toMatch(/Blocked resolved address/);
  });

  it("leaves the dev stack's loopback directory alone", () => {
    const config = {
      organizationId: "org:dev",
      url: "ldap://127.0.0.1:3389",
      bindMode: "bind_template" as const,
      subjectAttribute: "entryUUID",
      attributeMap: {},
      groupRoleMap: {},
    };
    expect(fencedLdapTarget(true, config)).toBe(config);
  });
});
