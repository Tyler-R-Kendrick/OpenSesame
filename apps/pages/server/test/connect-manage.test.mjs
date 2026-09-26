import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { verifyTargets } from "../../scripts/emit-connect-verify-targets.mjs";
import {
  createBodyOf,
  publicConnectorDetail,
  verifyTargetFor,
  verifyWithToken,
} from "../connect-manage.mjs";
import { VERIFY_TARGETS } from "../connect-verify-targets.generated.mjs";
import { isFunction, isString } from "../json-boundary.mjs";
import { handleManage } from "../manage.mjs";

const KEY = `${"k".repeat(24)}-operator-manage-key`;
const TOKEN = "provider_token_that_must_never_leave_the_relay";
const original = {
  VERCEL_TOKEN: process.env.VERCEL_TOKEN,
  OPENSESAME_CONNECT_MANAGE_KEY: process.env.OPENSESAME_CONNECT_MANAGE_KEY,
};
const originalFetch = globalThis.fetch;
let calls = [];

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Vercel API and provider stubs keyed by `METHOD url-prefix`. */
function stub(routes) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, method: init.method ?? "GET" };
    calls.push(call);
    for (const [key, answer] of Object.entries(routes)) {
      const [method, prefix] = key.split(" ");
      if (call.method === method && call.url.startsWith(prefix)) {
        return isFunction(answer) ? answer(call) : reply(answer);
      }
    }
    return reply({ error: { code: "not_found" } }, 404);
  };
}

function manage(path, body) {
  return handleManage({
    method: "POST",
    path,
    origin: "http://localhost:1",
    requestHost: "https://relay.example",
    authorization: `Bearer ${KEY}`,
    body,
  });
}

beforeEach(() => {
  process.env.VERCEL_TOKEN = "vercel_operator_token";
  process.env.OPENSESAME_CONNECT_MANAGE_KEY = KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("configured create", () => {
  it("forwards the whole configuration, and only Connect's create keys", () => {
    const body = createBodyOf(
      {
        connector: {
          service: "resend",
          name: "wedding-resend",
          uid: "resend/wedding",
          type: "oauth",
          data: { clientId: "cid", clientSecret: "shh" },
          teamId: "team_elsewhere",
          projectId: "prj_elsewhere",
        },
      },
      "prj_operator",
    );
    assert.deepEqual(body, {
      service: "resend",
      name: "wedding-resend",
      uid: "resend/wedding",
      type: "oauth",
      data: { clientId: "cid", clientSecret: "shh" },
      projectId: "prj_operator",
    });
  });

  it("refuses shapes Connect would misread", () => {
    // A refused body comes back as the refusal's message, a string.
    assert.ok(isString(createBodyOf({})));
    assert.ok(isString(createBodyOf({ service: "x", type: "slack" })));
    assert.ok(isString(createBodyOf({ service: "x", uid: "no slash" })));
    assert.ok(
      isString(createBodyOf({ service: "x", connectionMethod: "managed" })),
    );
  });

  it("answers the created connector with its secrets removed", async () => {
    stub({
      "POST https://api.vercel.com/v1/connect/connectors": {
        connector: {
          id: "scl_1",
          uid: "resend/wedding",
          data: {
            clientId: "cid",
            clientSecret: "shh",
            serverUrl: "https://api.resend.com",
          },
        },
      },
    });
    const outcome = await manage("/api/connect/connectors", {
      connector: { service: "resend", name: "w", type: "oauth", data: {} },
    });
    assert.equal(outcome.status, 200);
    assert.doesNotMatch(outcome.body, /shh/);
    assert.match(outcome.body, /api\.resend\.com/);
  });
});

describe("connector detail", () => {
  it("drops every secret-shaped field however deep", () => {
    const out = publicConnectorDetail({
      data: {
        clientId: "cid",
        clientSecret: "a",
        privateKeyPem: "b",
        webhookSecret: "c",
        values: [{ value: "d" }],
        nested: { apiToken: "e", password: "f" },
        tokenEndpointAuthMethod: "client_secret_post",
      },
    });
    assert.doesNotMatch(JSON.stringify(out), /"[abcdef]"/);
    assert.equal(out.data.clientId, "cid");
  });

  it("reads and updates through the management key", async () => {
    stub({
      "GET https://api.vercel.com/v1/connect/connectors/scl_1": {
        connector: { id: "scl_1", data: { clientSecret: "shh" } },
      },
      "PATCH https://api.vercel.com/v1/connect/connectors/scl_1": (call) =>
        reply({ connector: { id: "scl_1", ...JSON.parse(call.init.body) } }),
    });
    const read = await manage("/api/connect/connector/read", {
      connectorId: "scl_1",
    });
    assert.equal(read.status, 200);
    assert.doesNotMatch(read.body, /shh/);
    const update = await manage("/api/connect/connector/update", {
      connectorId: "scl_1",
      update: { name: "renamed", data: { clientId: "c2" }, teamId: "x" },
    });
    assert.equal(update.status, 200);
    const sent = JSON.parse(calls.at(-1).init.body);
    assert.deepEqual(sent, { name: "renamed", data: { clientId: "c2" } });
  });
});

describe("authorize", () => {
  it("authorizes on behalf of a person", async () => {
    stub({
      "POST https://api.vercel.com/v1/connect/authorize/scl_1": {
        url: "https://provider.example/authorize",
      },
    });
    const outcome = await manage("/api/connect/authorize", {
      connectorId: "scl_1",
      subject: { type: "user", id: "prn_abc" },
    });
    assert.equal(outcome.status, 200);
    assert.deepEqual(JSON.parse(calls[0].init.body).subject, {
      type: "user",
      id: "prn_abc",
    });
  });

  it("refuses a malformed subject", async () => {
    stub({});
    const outcome = await manage("/api/connect/authorize", {
      connectorId: "scl_1",
      subject: { type: "user", id: "a b" },
    });
    assert.equal(outcome.status, 400);
    assert.equal(calls.length, 0);
  });
});

describe("token proof", () => {
  const [service, targets] = Object.entries(VERIFY_TARGETS).find(
    ([, row]) => row.mcp,
  );

  it("proves a token without ever answering it", async () => {
    stub({
      "GET https://api.vercel.com/v1/connect/connectors/scl_1": {
        connector: { id: "scl_1", service, connectionMethod: "mcp", data: {} },
      },
      "POST https://api.vercel.com/v1/connect/token/scl_1": {
        token: TOKEN,
        expiresAt: 1_900_000_000_000,
        scopes: ["read"],
      },
      [`POST ${targets.mcp.url}`]: { jsonrpc: "2.0", id: 1, result: {} },
    });
    const outcome = await manage("/api/connect/token-check", {
      connectorId: "scl_1",
      subject: { type: "user", id: "prn_abc" },
    });
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.includes(TOKEN), false);
    const body = JSON.parse(outcome.body);
    assert.match(body.fingerprint, /^[0-9a-f]{12}$/);
    assert.deepEqual(body.verified, { status: 200, ok: true, account: "" });
    const verify = calls.at(-1);
    assert.equal(verify.url, targets.mcp.url);
    assert.equal(verify.init.redirect, "manual");
    assert.equal(verify.init.headers.get("authorization"), `Bearer ${TOKEN}`);
  });

  it("takes the verify target from the pinned presets, never the request", async () => {
    stub({
      "GET https://api.vercel.com/v1/connect/connectors/scl_1": {
        connector: { id: "scl_1", service: "not-a-known-service" },
      },
      "POST https://api.vercel.com/v1/connect/token/scl_1": { token: TOKEN },
    });
    const outcome = await manage("/api/connect/token-check", {
      connectorId: "scl_1",
      subject: { type: "app" },
      verifyUrl: "https://attacker.example/collect",
    });
    assert.equal(outcome.status, 200);
    assert.equal(JSON.parse(outcome.body).verified, null);
    assert.equal(
      calls.some((call) => call.url.includes("attacker")),
      false,
    );
  });

  it("passes Connect's refusal through without a token", async () => {
    stub({
      "GET https://api.vercel.com/v1/connect/connectors/scl_1": {
        connector: { id: "scl_1", service },
      },
      "POST https://api.vercel.com/v1/connect/token/scl_1": () =>
        reply(
          {
            error: {
              code: "authorization_required",
              message: "Authorize first.",
            },
          },
          403,
        ),
    });
    const outcome = await manage("/api/connect/token-check", {
      connectorId: "scl_1",
      subject: { type: "user", id: "prn_abc" },
    });
    assert.equal(outcome.status, 403);
    assert.equal(JSON.parse(outcome.body).error.code, "authorization_required");
  });
});

describe("token proof boundaries", () => {
  it("needs the management key", async () => {
    stub({});
    const outcome = await handleManage({
      method: "POST",
      path: "/api/connect/token-check",
      origin: "http://localhost:1",
      body: { connectorId: "scl_1", subject: { type: "app" } },
    });
    assert.equal(outcome.status, 401);
    assert.equal(calls.length, 0);
  });

  it("skips a target whose host still names a placeholder", async () => {
    const result = await verifyWithToken(
      {
        kind: "oauth",
        method: "GET",
        url: "https://{domain}/me",
        header: "Authorization",
        scheme: "Bearer",
      },
      TOKEN,
      () => assert.fail("must not fetch"),
    );
    assert.equal(result, null);
  });

  it("chooses the API-key call for an API-key connector", () => {
    const withKey = Object.entries(VERIFY_TARGETS).find(
      ([, row]) => row.apiKey,
    );
    if (!withKey) return;
    const [id, row] = withKey;
    assert.equal(verifyTargetFor({ service: id, type: "api-key" }), row.apiKey);
  });
});

describe("generated verify targets", () => {
  it("match the specs", () => {
    assert.deepEqual(
      JSON.parse(JSON.stringify(VERIFY_TARGETS)),
      verifyTargets(),
    );
  });

  it("are all https", () => {
    for (const row of Object.values(VERIFY_TARGETS)) {
      for (const target of Object.values(row)) {
        assert.equal(
          new URL(target.url.replace(/\{[a-z_]+\}/, "x")).protocol,
          "https:",
        );
      }
    }
  });
});
