import { once } from "node:events";
import { serve } from "@hono/node-server";
import { isString, overlapCast } from "@opensesame/os-domain";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/create-app.js";

describe("authentication service in a real browser", () => {
  const { app } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  let origin = "";

  beforeAll(async () => {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || isString(address))
      throw new Error("test server did not bind");
    origin = `http://localhost:${address.port}`;
  });

  afterAll(async () => {
    server.close();
    await once(server, "close");
  });

  it("registers and verifies a passkey with actual WebAuthn cryptography", async () => {
    const provisional = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const session = overlapCast(await provisional.json());
    const auth = { authorization: `Bearer ${session.accessToken}` };
    await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": "authentication-browser-principal",
      },
      body: JSON.stringify({
        kind: "oidc",
        issuer: "https://browser.example",
        subject: "browser-owner",
        assurance: "verified",
      }),
    });
    const created = await app.request("/v1/authentication/applications", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Browser proof",
        rpId: "localhost",
        origins: [origin],
      }),
    });
    const createdBody = overlapCast(await created.json());
    const applicationId: string = overlapCast(createdBody.application.id);
    const apiSecret: string = overlapCast(createdBody.apiSecret);
    const registration = await app.request(
      "/v1/authentication/backend/registration-tokens",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          applicationId,
          userId: "browser-user",
          userName: "Browser User",
          displayName: "Browser User",
        }),
      },
    );
    const registrationToken: string = overlapCast(
      overlapCast(await registration.json()).token,
    );

    const browser = await chromium.launch({
      headless: true,
      ...(process.env.OPENSESAME_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.OPENSESAME_TEST_CHROMIUM_PATH }
        : undefined),
    });
    try {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await page.goto(`${origin}/v1/health/live`);
      const result = await page.evaluate(
        async ({ applicationId, registrationToken }) => {
          const post = async <Body extends object>(
            path: string,
            body: Body,
          ) => {
            const response = await fetch(`/v1/authentication/public${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error(`${path}:${response.status}`);
            return response.json();
          };
          const creationJson = await post("/register/options", {
            applicationId,
            token: registrationToken,
          });
          const credential = await navigator.credentials.create({
            publicKey:
              PublicKeyCredential.parseCreationOptionsFromJSON(creationJson),
          });
          if (!(credential instanceof PublicKeyCredential)) {
            throw new Error("browser did not create a public-key credential");
          }
          await post("/register/verify", {
            applicationId,
            response: credential.toJSON(),
          });
          const requestJson = await post("/signin/options", {
            applicationId,
            mode: "discoverable",
          });
          const assertion = await navigator.credentials.get({
            publicKey:
              PublicKeyCredential.parseRequestOptionsFromJSON(requestJson),
          });
          if (!(assertion instanceof PublicKeyCredential)) {
            throw new Error("browser did not return a public-key credential");
          }
          return post("/signin/verify", {
            applicationId,
            response: assertion.toJSON(),
          });
        },
        { applicationId, registrationToken },
      );
      const exchanged = await app.request(
        "/v1/authentication/backend/signin/verify-token",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiSecret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ applicationId, token: result.token }),
        },
      );
      expect(await exchanged.json()).toMatchObject({
        success: true,
        userId: "browser-user",
        type: "passkey",
      });
    } finally {
      await browser.close();
    }
  });
});
