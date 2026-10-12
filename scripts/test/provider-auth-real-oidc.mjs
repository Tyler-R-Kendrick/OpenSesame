/** Provider protocol test: real S256 issuer exchange -> OpenBao-issued token. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { requestJson } from "./provider-auth-services.mjs";

export async function proveRealProviderGrant({
  bao,
  idp,
  redirectUri,
  browser,
}) {
  const nonce = randomBytes(32).toString("base64url");
  const auth = await bao.api("auth/oidc/oidc/auth_url", {
    role: "browser",
    redirect_uri: redirectUri,
    client_nonce: nonce,
  });
  const authorization = new URL(auth.data.auth_url);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  const context = await browser.newContext();
  const page = await context.newPage();
  const failed = [];
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    failed.push(
      `${url.origin}${url.pathname}: ${request.failure()?.errorText}`,
    );
  });
  let callback;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin === new URL(redirectUri).origin &&
      url.searchParams.has("code")
    )
      callback = url;
  });
  try {
    await page.goto(authorization.href);
    await page.getByLabel("Username", { exact: true }).fill("provider-user");
    await page.getByLabel("Password", { exact: true }).fill(idp.password);
    await page
      .getByRole("button", { name: "Sign in to provider", exact: true })
      .click();
    await page
      .waitForURL((url) => url.origin === new URL(redirectUri).origin)
      .catch(() => {
        throw new Error(
          `Provider callback did not arrive: ${failed.join(", ")}`,
        );
      });
    assert.ok(callback?.searchParams.get("code"));
    assert.equal(
      callback.searchParams.get("state"),
      authorization.searchParams.get("state"),
    );
    const exchange = new URL(`${bao.endpoint}/v1/auth/oidc/oidc/callback`);
    for (const field of ["state", "code"])
      exchange.searchParams.set(field, callback.searchParams.get(field));
    exchange.searchParams.set("nonce", authorization.searchParams.get("nonce"));
    exchange.searchParams.set("client_nonce", nonce);
    const wrongState = new URL(exchange);
    wrongState.searchParams.set("state", randomBytes(32).toString("hex"));
    const wrong = await requestJson(wrongState, { ca: bao.ca });
    assert.equal(
      wrong.status,
      400,
      "Real OpenBao rejects another authorization state before token issuance",
    );
    const grant = await requestJson(exchange, { ca: bao.ca });
    assert.equal(grant.status, 200);
    return await proveProviderOperations({ bao, exchange, grant });
  } finally {
    await context.close();
  }
}

async function proveProviderOperations({ bao, exchange, grant }) {
  const token = grant.body.auth.client_token;
  assert.ok(
    /^[!-~]{16,4096}$/.test(token),
    "Provider must issue a nonempty bearer credential",
  );
  assert.ok(grant.body.auth.policies.includes("browser-read"));
  assert.ok(!grant.body.auth.policies.includes("root"));
  const lookup = await requestJson(
    `${bao.endpoint}/v1/auth/token/lookup-self`,
    { ca: bao.ca, token },
  );
  assert.equal(lookup.status, 200);
  assert.ok(lookup.body.data.entity_id);
  const read = await requestJson(
    `${bao.endpoint}/v1/secret/data/browser-auth`,
    { ca: bao.ca, token },
  );
  assert.equal(read.status, 200);
  assert.equal(
    read.body.data.data.message,
    "Authorized secret from real provider",
  );
  const forbidden = await requestJson(`${bao.endpoint}/v1/sys/mounts`, {
    ca: bao.ca,
    token,
  });
  assert.equal(forbidden.status, 403);
  const replay = await requestJson(exchange, { ca: bao.ca });
  assert.equal(replay.status, 400);
  const revoke = await requestJson(
    `${bao.endpoint}/v1/auth/token/revoke-self`,
    { ca: bao.ca, token, method: "POST", body: {} },
  );
  assert.equal(revoke.status, 204);
  const revoked = await requestJson(
    `${bao.endpoint}/v1/auth/token/lookup-self`,
    { ca: bao.ca, token },
  );
  assert.equal(revoked.status, 403);
  return {
    service: bao.name,
    issuer: "oidc-provider 9.11.2",
    pkce: "S256",
    realTokenIssued: true,
    authorizedRead: true,
    policyDenial: true,
    callbackReplayDenied: true,
    revokedTokenDenied: true,
  };
}
