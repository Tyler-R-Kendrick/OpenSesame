import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { AGENT_AUTH_OAUTH_CLIENT_ID } from "../ui/agent-auth-pages.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of close.splice(0).reverse()) await release();
});

async function deployment() {
  const requests: {
    path: string;
    method: string;
    fields: Record<string, string>;
  }[] = [];
  let reply = "{}";
  const server = createServer({}, async (incoming, outgoing) => {
    const parts: Buffer[] = [];
    for await (const part of incoming) parts.push(Buffer.from(part));
    requests.push({
      path: incoming.url ?? "",
      method: incoming.method ?? "",
      fields: Object.fromEntries(
        new URLSearchParams(Buffer.concat(parts).toString()),
      ),
    });
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(reply);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  close.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("loopback address missing");
  const issuer = `http://127.0.0.1:${address.port}`;
  const plane = createControlPlane({
    processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
    config: { port: 0, publicUrl: issuer, issuer },
  });
  return {
    plane,
    issuer,
    requests,
    respond: (value: string) => {
      reply = value;
    },
  };
}

type Deployment = Awaited<ReturnType<typeof deployment>>;
function cookieValue(response: Response, name: string) {
  const found = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
  if (!found) throw new Error(`missing cookie ${name}`);
  return found.split(";")[0] ?? "";
}

async function start(
  f: Deployment,
  returnTo = "/claim?claim_attempt_token=fixture",
) {
  const response = await f.plane.app.request("/login/start", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ return_to: returnTo, provider: "fixture-idp" }),
  });
  expect(response.status).toBe(303);
  const destination = response.headers.get("location");
  if (!destination) throw new Error("authorization redirect missing");
  const authorize = new URL(destination);
  const cookie = cookieValue(response, "os_agent_auth_oidc");
  const stored: { v: string; r: string; s: string } = overlapCast(
    JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))),
  );
  return { response, authorize, cookie, stored };
}

async function sessionState(f: Deployment) {
  return {
    sessions: [...(await f.plane.ctx.stores.provisionalSessions.entries())],
    tokens: [...(await f.plane.ctx.stores.provisionalTokens.entries())],
  };
}

it("binds the login redirect to its actual PKCE cookie, state and same-origin return path", async () => {
  const f = await deployment();
  const begun = await start(f);
  expect(begun.authorize.origin).toBe(f.issuer);
  expect(begun.authorize.pathname).toBe("/auth");
  expect(begun.authorize.searchParams.get("client_id")).toBe(
    AGENT_AUTH_OAUTH_CLIENT_ID,
  );
  expect(begun.authorize.searchParams.get("redirect_uri")).toBe(
    `${f.issuer}/claim/resume`,
  );
  expect(begun.authorize.searchParams.get("code_challenge_method")).toBe(
    "S256",
  );
  expect(begun.authorize.searchParams.get("code_challenge")).toBe(
    createHash("sha256").update(begun.stored.v).digest("base64url"),
  );
  expect(begun.authorize.searchParams.get("state")).toBe(begun.stored.s);
  expect(begun.authorize.searchParams.get("login_hint_provider")).toBe(
    "fixture-idp",
  );
  expect(begun.response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  expect(begun.response.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
  expect(await sessionState(f)).toEqual({ sessions: [], tokens: [] });
  expect(f.requests).toHaveLength(0);
});

it.each([
  "missing-cookie",
  "malformed-cookie",
  "wrong-state",
  "provider-error",
])(
  "refuses %s before any token transport or provisional session mutation",
  async (fault) => {
    const f = await deployment();
    const begun = await start(f);
    const before = await sessionState(f);
    const cookie =
      fault === "missing-cookie"
        ? ""
        : fault === "malformed-cookie"
          ? "os_agent_auth_oidc=%7B"
          : begun.cookie;
    const query = new URLSearchParams({
      code: "never-redeemed",
      state: fault === "wrong-state" ? "foreign-state" : begun.stored.s,
    });
    if (fault === "provider-error") query.set("error", "access_denied");
    const response = await f.plane.app.request(`/claim/resume?${query}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("set-cookie")).toMatch(/os_agent_auth_oidc=;/);
    expect(f.requests).toHaveLength(0);
    expect(await sessionState(f)).toEqual(before);
  },
);

it("clears the consumed state cookie and returns safely when no code was issued", async () => {
  const f = await deployment();
  const begun = await start(f, "https://foreign.example/collect");
  const response = await f.plane.app.request(
    `/claim/resume?state=${encodeURIComponent(begun.stored.s)}`,
    {
      headers: { cookie: begun.cookie },
    },
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/claim");
  expect(response.headers.get("set-cookie")).toMatch(/os_agent_auth_oidc=;/);
  expect(await sessionState(f)).toEqual({ sessions: [], tokens: [] });
  expect(f.requests).toHaveLength(0);
});

it.each(["{", "{}", '{"access_token":"unknown-provider-token"}'])(
  "does not establish a session from an unusable actual token response %j",
  async (reply) => {
    const f = await deployment();
    const begun = await start(f);
    const before = await sessionState(f);
    f.respond(reply);
    const response = await f.plane.app.request(
      `/claim/resume?state=${encodeURIComponent(begun.stored.s)}&code=fixture-code`,
      {
        headers: { cookie: begun.cookie },
      },
    );
    expect(response.status).toBe(400);
    expect(f.requests).toEqual([
      {
        path: "/token",
        method: "POST",
        fields: {
          grant_type: "authorization_code",
          client_id: AGENT_AUTH_OAUTH_CLIENT_ID,
          code: "fixture-code",
          redirect_uri: `${f.issuer}/claim/resume`,
          code_verifier: begun.stored.v,
        },
      },
    ]);
    expect(await sessionState(f)).toEqual(before);
  },
);

// The loopback fixture delivers a token saved by the real local provider.
// This proves transport -> provider lookup -> cookie/session binding; it is
// not a full external IdP authorization-code or PKCE verifier acceptance test.
it("binds a resumed session to a genuine locally issued provider token and its principal", async () => {
  const f = await deployment();
  const arrival = await f.plane.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(arrival.status).toBe(201);
  const principal: { principalId: string } = overlapCast(await arrival.json());
  await f.plane.ctx.oauth.clientStore.insertAtomic({
    id: AGENT_AUTH_OAUTH_CLIENT_ID,
    admissionMode: "pre_registered",
    displayName: "Controlled claim client",
    redirectUris: [`${f.issuer}/claim/resume`],
    sectorIdentifier: f.issuer,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    allowedResources: [],
    state: "active",
  });
  const provider: {
    Client: { find(id: string): Promise<unknown> };
    AccessToken: new (input: {
      client: unknown;
      accountId: string;
      clientId: string;
      scope: string;
    }) => { save(): Promise<string> };
  } = overlapCast(f.plane.ctx.oauth.provider);
  const client = await provider.Client.find(AGENT_AUTH_OAUTH_CLIENT_ID);
  expect(client).toBeDefined();
  const issued = new provider.AccessToken({
    client,
    accountId: principal.principalId,
    clientId: AGENT_AUTH_OAUTH_CLIENT_ID,
    scope: "openid",
  });
  f.respond(JSON.stringify({ access_token: await issued.save() }));
  const begun = await start(f);
  const before = await sessionState(f);
  const response = await f.plane.app.request(
    `/claim/resume?state=${encodeURIComponent(begun.stored.s)}&code=fixture-code`,
    {
      headers: { cookie: begun.cookie },
    },
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(begun.stored.r);
  expect(f.requests).toHaveLength(1);
  const after = await sessionState(f);
  expect(after.sessions).toHaveLength(before.sessions.length + 1);
  expect(after.tokens).toHaveLength(before.tokens.length + 1);
  const sessionCookie = cookieValue(
    response,
    f.plane.ctx.config.provisionalCookieName,
  );
  const me = await f.plane.app.request("/v1/principals/me", {
    headers: { cookie: sessionCookie },
  });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ id: principal.principalId });
  expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
});
