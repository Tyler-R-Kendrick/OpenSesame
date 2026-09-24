import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleManage } from "../src/manage.mjs";

const KEY = `${"k".repeat(24)}-operator-manage-key`;
const ORIGIN = "http://localhost:1";
const RELAY = "https://relay.example";
const ENV_KEYS = [
  "VERCEL_TOKEN",
  "OPENSESAME_CONNECT_APP_ORIGINS",
  "OPENSESAME_CONNECT_MANAGE_KEY",
  "OPENSESAME_CONNECT_RELAY_ORIGIN",
];
const original = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
const originalFetch = globalThis.fetch;
let calls = [];

function stubVercel(reply = { ok: true }, status = 200) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(reply), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

function manage(method, path, extra = {}) {
  return handleManage({
    method,
    path,
    origin: ORIGIN,
    requestHost: RELAY,
    ...extra,
  });
}

const MUTATIONS = [
  ["/api/connect/connectors", { service: "github" }],
  ["/api/connect/authorize", { connectorId: "scl_github" }],
  ["/api/connect/revoke", { connectorId: "scl_github" }],
];

function callbackFor(returnTo, base = RELAY) {
  return `${base}/api/connect/callback?return_to=${encodeURIComponent(returnTo)}`;
}

beforeEach(() => {
  process.env.VERCEL_TOKEN = "vercel_operator_token";
  process.env.OPENSESAME_CONNECT_MANAGE_KEY = KEY;
  Reflect.deleteProperty(process.env, "OPENSESAME_CONNECT_RELAY_ORIGIN");
  stubVercel();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("handleManage", () => {
  it("refuses unknown origins", async () => {
    const outcome = await handleManage({
      method: "GET",
      path: "/api/connect/connectors",
      origin: "https://evil.example",
    });
    assert.equal(outcome.status, 403);
  });

  it("refuses a missing Origin instead of treating it as allowed", async () => {
    const outcome = await handleManage({
      method: "GET",
      path: "/api/connect/connectors",
      origin: "",
    });
    assert.equal(outcome.status, 403);
  });

  it("reports missing VERCEL_TOKEN instead of asking the browser", async () => {
    Reflect.deleteProperty(process.env, "VERCEL_TOKEN");
    process.env.OPENSESAME_CONNECT_APP_ORIGINS = "http://localhost:5180";
    const outcome = await handleManage({
      method: "GET",
      path: "/api/connect/connectors",
      origin: "http://localhost:5180",
    });
    assert.equal(outcome.status, 503);
    const body = JSON.parse(outcome.body);
    assert.equal(body.error.code, "unconfigured");
  });

  it("lets a browser preflight carry the management key", async () => {
    const outcome = await manage("OPTIONS", "/api/connect/authorize");
    assert.equal(outcome.status, 204);
    assert.match(
      outcome.headers["access-control-allow-headers"],
      /authorization/,
    );
  });
});

describe("management key", () => {
  for (const [path, body] of MUTATIONS) {
    it(`refuses ${path} with an allowed Origin and no key`, async () => {
      const outcome = await manage("POST", path, { body });
      assert.equal(outcome.status, 401);
      assert.equal(JSON.parse(outcome.body).error.code, "manage_key_required");
      assert.match(outcome.headers["www-authenticate"], /^Bearer/);
      assert.equal(calls.length, 0);
    });

    it(`refuses ${path} with a wrong key`, async () => {
      for (const authorization of [
        `Bearer ${KEY}x`,
        `Bearer ${KEY.slice(0, -1)}`,
        `Basic ${KEY}`,
        KEY,
      ]) {
        const outcome = await manage("POST", path, { body, authorization });
        assert.equal(outcome.status, 401, authorization);
      }
      assert.equal(calls.length, 0);
    });

    it(`refuses ${path} when the relay has no management key`, async () => {
      Reflect.deleteProperty(process.env, "OPENSESAME_CONNECT_MANAGE_KEY");
      const outcome = await manage("POST", path, {
        body,
        authorization: `Bearer ${KEY}`,
      });
      assert.equal(outcome.status, 403);
      assert.equal(JSON.parse(outcome.body).error.code, "management_disabled");
      assert.equal(calls.length, 0);
    });
  }

  it("treats a short management key as unset", async () => {
    process.env.OPENSESAME_CONNECT_MANAGE_KEY = "short";
    const outcome = await manage("POST", "/api/connect/revoke", {
      body: { connectorId: "scl_github" },
      authorization: "Bearer short",
    });
    assert.equal(outcome.status, 403);
    assert.equal(calls.length, 0);
  });

  it("creates, authorizes and revokes with the operator's key", async () => {
    const authorization = `Bearer ${KEY}`;
    stubVercel({ id: "scl_github", service: "github" });
    const created = await manage("POST", "/api/connect/connectors", {
      body: { service: "github" },
      authorization,
    });
    assert.equal(created.status, 200);
    assert.match(calls[0].url, /\/v1\/connect\/connectors/);
    assert.equal(
      calls[0].init.headers.get("authorization"),
      "Bearer vercel_operator_token",
    );

    stubVercel({ url: "https://vercel.com/connect/authorize/x" });
    const callbackUrl = callbackFor(
      "http://localhost:5180/connections?connection=scl_github",
    );
    const authorized = await manage("POST", "/api/connect/authorize", {
      body: { connectorId: "scl_github", callbackUrl },
      authorization,
    });
    assert.equal(authorized.status, 200);
    assert.equal(JSON.parse(calls[0].init.body).returnUrl, callbackUrl);

    stubVercel({});
    const revoked = await manage("POST", "/api/connect/revoke", {
      body: { connectorId: "scl_github" },
      authorization,
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(JSON.parse(revoked.body), { revoked: true });
    assert.equal(calls[0].init.method, "DELETE");
  });
});

describe("authorize callbackUrl", () => {
  const authorization = `Bearer ${KEY}`;
  const good = "http://localhost:5180/connections?connection=scl_github";

  for (const callbackUrl of [
    "https://evil.example/steal",
    callbackFor(good, "https://evil.example"),
    `${RELAY}/api/connect/other?return_to=${encodeURIComponent(good)}`,
    callbackFor("https://evil.example/landing"),
    `${callbackFor(good)}&extra=1`,
    `${callbackFor(good)}#frag`,
    callbackFor(good, "https://user:pw@relay.example"),
  ]) {
    it(`refuses ${callbackUrl}`, async () => {
      const outcome = await manage("POST", "/api/connect/authorize", {
        body: { connectorId: "scl_github", callbackUrl },
        authorization,
      });
      assert.equal(outcome.status, 400);
      assert.equal(JSON.parse(outcome.body).error.code, "invalid_callback");
      assert.equal(calls.length, 0);
    });
  }

  it("accepts the relay's public origin behind a Host-rewriting proxy", async () => {
    process.env.OPENSESAME_CONNECT_RELAY_ORIGIN =
      "https://10.0.0.2.nip.io:8443";
    const callbackUrl = callbackFor(good, "https://10.0.0.2.nip.io:8443");
    const outcome = await manage("POST", "/api/connect/authorize", {
      body: { connectorId: "scl_github", callbackUrl },
      authorization,
      requestHost: "http://127.0.0.1:8789",
    });
    assert.equal(outcome.status, 200);
  });
});

describe("anonymous connector list", () => {
  it("answers only the fields the catalog maps", async () => {
    stubVercel({
      connectors: [
        {
          id: "scl_github",
          uid: "github/acme",
          name: "acme",
          service: "github",
          createdAt: 1,
          clientId: "Iv1.secret-client",
          clientSecret: "shh",
          teamId: "team_operator",
          ownerId: "user_operator",
          appTokens: { scopes: ["repo"], token: "gho_leak" },
        },
      ],
      pagination: { next: "cursor" },
    });
    const outcome = await manage("GET", "/api/connect/connectors");
    assert.equal(outcome.status, 200);
    assert.deepEqual(JSON.parse(outcome.body), {
      connectors: [
        {
          id: "scl_github",
          uid: "github/acme",
          name: "acme",
          service: "github",
          createdAt: 1,
          appTokens: { scopes: ["repo"] },
        },
      ],
    });
    assert.doesNotMatch(outcome.body, /secret|shh|team_operator|gho_/);
  });

  it("reduces an upstream error to its code and message", async () => {
    stubVercel(
      { error: { code: "forbidden", message: "no", invalidToken: "x" } },
      403,
    );
    const outcome = await manage("GET", "/api/connect/connectors");
    assert.equal(outcome.status, 403);
    assert.deepEqual(JSON.parse(outcome.body), {
      error: { code: "forbidden", message: "no" },
    });
  });
});
