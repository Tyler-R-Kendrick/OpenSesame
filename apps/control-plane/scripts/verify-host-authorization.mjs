// Real Chromium WebAuthn + real Identity signature validation, all network intercepted.
// Run with: pnpm --filter @opensesame/control-plane exec tsx scripts/verify-host-authorization.mjs
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
import { importJWK, jwtVerify } from "jose";
import { createControlPlane } from "../src/create-app.ts";

const identity = "http://localhost:8788";
const pages = "http://localhost:5180";
const signingKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ format: "jwk" });
const signingJwk = {
  ...signingKey,
  alg: "RS256",
  kid: "browser-test",
  use: "sig",
};
const { app, ctx } = createControlPlane({
  processEnv: {
    OPENSESAME_ENV: "test",
    NODE_ENV: "test",
    OPENSESAME_CLAIM_PEPPER: randomBytes(32).toString("base64url"),
    OPENSESAME_OPERATOR_TOKEN: randomBytes(32).toString("base64url"),
    OPENSESAME_HOST_AUTHORIZATION_AUDIENCES: "http://127.0.0.1:8787",
    OPENSESAME_JWKS_JSON: JSON.stringify({ keys: [signingJwk] }),
  },
  config: {
    publicUrl: identity,
    issuer: identity,
    corsOrigins: [pages],
    bootstrapPersonalOrganization: true,
  },
});
const minted = await (
  await app.request("/v1/principals/provisional", { method: "POST" })
).json();
assert.match(minted.accessToken, /^pst_[A-Za-z0-9_-]+$/);
const memberships = await ctx.stores.organizationMemberships.listByPrincipal(
  minted.principalId,
);
const organizationId = memberships[0]?.organizationId;
assert.ok(organizationId);
const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKey = key.publicKey.export({ format: "jwk" });
const credentialId = randomBytes(32);
await ctx.passkeys.register(minted.principalId, {
  credentialId: credentialId.toString("base64url"),
  counter: 0,
  publicKey: Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(publicKey.x, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(publicKey.y, "base64url"),
  ]),
});
const challenge = {
  challenge_id: "browser-oracle",
  challenge_digest: "a".repeat(64),
  host_audience: "http://127.0.0.1:8787",
  organization_id: organizationId,
  operation: "agent.browser.control",
  transition: "take",
  target_id: "owned-run",
  origin: pages,
  dpop_jkt: "b".repeat(43),
  expires_at: Math.floor(Date.now() / 1000) + 240,
};
const state = randomBytes(32).toString("base64url");
const popupUrl = `${identity}/v1/host-authorizations/ceremony?origin=${encodeURIComponent(pages)}&state=${state}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM,
});
try {
  const context = await browser.newContext();
  const errors = [];
  const outcomes = [];
  context.on("page", (page) =>
    page.on("pageerror", (error) => errors.push(error.message)),
  );
  await context.addCookies([
    {
      name: ctx.config.provisionalCookieName,
      value: minted.accessToken,
      url: identity,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin === identity) {
      const response = await app.request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postDataBuffer(),
      });
      outcomes.push(
        `${request.method()} ${new URL(request.url()).pathname} ${response.status}`,
      );
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    } else if (request.url() === `${pages}/`) {
      await route.fulfill({
        contentType: "text/html",
        body: '<button id="open">Verify</button>',
      });
    } else await route.abort();
  });
  const page = await context.newPage();
  await page.goto(pages);
  await page.evaluate(
    ({ url, origin, state, challenge }) => {
      let popup;
      window.addEventListener("message", (event) => {
        if (
          event.origin !== origin ||
          event.source !== popup ||
          event.data.state !== state
        )
          return;
        if (event.data.type === "opensesame:host-authorization-ready")
          popup.postMessage(
            { type: "opensesame:host-challenge", state, challenge },
            origin,
          );
        if (event.data.type === "opensesame:host-authorization") {
          const result = document.createElement("output");
          result.id = "result";
          // Test-only in-memory result capture; production never inserts assertions into the DOM.
          result.textContent = JSON.stringify(event.data);
          document.body.append(result);
        }
      });
      document.getElementById("open").onclick = () => {
        popup = window.open(url, "_blank");
      };
    },
    { url: popupUrl, origin: identity, state, challenge },
  );
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Verify" }).click();
  const popup = await opened;
  const cdp = await context.newCDPSession(popup);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: credentialId.toString("base64"),
      isResidentCredential: true,
      rpId: "localhost",
      userHandle: Buffer.from(minted.principalId).toString("base64"),
      privateKey: key.privateKey
        .export({ type: "pkcs8", format: "der" })
        .toString("base64"),
      signCount: 0,
    },
  });
  await popup.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (options) => {
      try {
        return await get(options);
      } catch (error) {
        document.body.dataset.webauthnError = error.name;
        throw error;
      }
    };
  });
  await popup.getByText("Check the request", { exact: false }).waitFor();
  assert.equal(
    await page.locator("#result").count(),
    0,
    "No result before human approval",
  );
  assert.ok((await popup.locator("#facts").innerText()).includes("owned-run"));
  if (process.env.HOST_AUTH_SCREENSHOT)
    await popup.screenshot({ path: process.env.HOST_AUTH_SCREENSHOT });
  await popup.getByRole("button", { name: "Verify with passkey" }).click();
  await page.locator("#result").waitFor();
  const result = JSON.parse(await page.locator("#result").textContent());
  const browserError = await popup
    .locator("body")
    .getAttribute("data-webauthn-error");
  assert.equal(
    result.error,
    undefined,
    `Real Identity verifier accepted virtual authenticator evidence: ${browserError}, ${outcomes.join(", ")}`,
  );
  const verificationKey = {
    kty: "RSA",
    n: signingJwk.n,
    e: signingJwk.e,
    alg: "RS256",
  };
  const verified = await jwtVerify(
    result.assertion,
    await importJWK(verificationKey, "RS256"),
    { issuer: identity, audience: challenge.host_audience },
  );
  assert.equal(verified.protectedHeader.typ, "host-authorization+jwt");
  assert.equal(verified.payload.challenge_digest, challenge.challenge_digest);
  assert.equal(verified.payload.transition, "take");
  assert.equal(verified.payload.assurance, "phishing_resistant");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real Chromium popup, cookie session, UV passkey, exact transaction and RS256 assertion",
  );
  await context.close();
} finally {
  await browser.close();
}
