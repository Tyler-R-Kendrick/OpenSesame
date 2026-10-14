import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "vitest";
import { createTailscaleProvisioningFixture } from "./tailscale-provisioning-fixture.mjs";

test("browser fixture uses actual CORS HTTP and binds one-use codes/keys to the generated OAuth app", async () => {
  const origin = "https://operator.example";
  const fixture = createTailscaleProvisioningFixture({ allowedOrigin: origin });
  const server = createServer(async (request, response) => {
    if (!(await fixture.handle(request, response))) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && Object(address) === address);
  const base = `http://127.0.0.1:${address.port}/tailscale-fixture`;
  try {
    const preflight = await fetch(`${base}/api/v2/tailnet/-/oauth-apps`, {
      method: "OPTIONS",
      headers: { Origin: origin, "access-control-request-method": "POST" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    const refused = await fetch(`${base}/api/v2/tailnet/-/oauth-apps`, {
      method: "POST",
      headers: { Origin: "https://other.example" },
    });
    assert.equal(refused.status, 403);
    assert.equal(fixture.stats.registrations, 0);
    const callback = `${origin}/oauth-callback`;
    const response = await fetch(`${base}/api/v2/tailnet/-/oauth-apps`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Basic ${Buffer.from(`${fixture.adminToken}:`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "OpenSesame fixture deployment",
        redirectUris: [callback],
        scopes: ["auth_keys:create:once"],
      }),
    });
    assert.equal(response.status, 201);
    const app = await response.json();
    const verify = await fetch(
      `${base}/api/v2/tailnet/-/oauth-apps/${app.id}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${fixture.adminToken}:`).toString("base64")}`,
        },
      },
    );
    assert.equal(verify.status, 200);
    assert.equal((await verify.json()).clientSecret, undefined);
    const authorize = new URL("https://login.tailscale.com/a/oauth_authorize");
    authorize.search = new URLSearchParams({
      client_id: app.id,
      redirect_uri: callback,
      scope: "auth_keys:create:once",
      state: "long-fixture-csrf-state-which-is-more-than-32-characters",
      response_type: "code",
    }).toString();
    const page = fixture.consentPage(authorize.href);
    const escapedCallback = page.match(/<a href="([^"]+)">/u)?.[1];
    assert(escapedCallback);
    const issued = new URL(escapedCallback.replaceAll("&amp;", "&"));
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: issued.searchParams.get("code"),
      client_id: app.id,
      client_secret: app.clientSecret,
      redirect_uri: callback,
    });
    const init = {
      method: "POST",
      headers: {
        Origin: origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    };
    const exchange = await fetch(`${base}/api/v2/oauth/token`, init);
    assert.equal(exchange.status, 200);
    const token = await exchange.json();
    assert.equal(token.expires_in, 3600);
    assert(fixture.consumeDeviceKey(token.access_token));
    assert.equal(fixture.consumeDeviceKey(token.access_token), false);
    const replay = await fetch(`${base}/api/v2/oauth/token`, init);
    assert.equal(replay.status, 400);
    assert.deepEqual(fixture.stats, {
      registrations: 1,
      verifications: 1,
      consents: 1,
      exchanges: 1,
      consumedDeviceKeys: 1,
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
