import { simpleWebAuthnSeams } from "@opensesame/auth-upstream";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";

function clientData(challenge: string): string {
  return Buffer.from(
    JSON.stringify({
      type: "webauthn.create",
      challenge,
      origin: "http://localhost:5180",
    }),
  ).toString("base64url");
}

async function verifiedPrincipal(
  app: ReturnType<typeof createControlPlane>["app"],
) {
  const created = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const session = overlapCast(await created.json());
  const auth = { authorization: `Bearer ${session.accessToken}` };
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": "authentication-service-principal",
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject: "authentication-service-owner",
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  const principalId: string = overlapCast(session.principalId);
  return { auth, principalId };
}

describe("authentication service API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serves the complete passkey lifecycle and fences secrets and tenants", async () => {
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const owner = await verifiedPrincipal(app);
    vi.spyOn(
      simpleWebAuthnSeams,
      "verifyRegistrationResponse",
    ).mockResolvedValue({
      verified: true,
      registrationInfo: {
        fmt: "none",
        aaguid: "00000000-0000-0000-0000-000000000000",
        credentialType: "public-key",
        credentialBackedUp: false,
        credentialDeviceType: "singleDevice",
        origin: "http://localhost:5180",
        rpID: "localhost",
        userVerified: true,
        attestationObject: new Uint8Array(),
        credential: {
          id: "credential-http-1",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ["internal"],
        },
      },
    });
    vi.spyOn(
      simpleWebAuthnSeams,
      "verifyAuthenticationResponse",
    ).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 0,
        credentialID: "credential-http-1",
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: "http://localhost:5180",
        rpID: "localhost",
      },
    });

    const created = await app.request("/v1/authentication/applications", {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Pages demo",
        rpId: "localhost",
        origins: ["http://localhost:5180"],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = overlapCast(await created.json());
    const applicationId: string = overlapCast(createdBody.application.id);
    const apiSecret: string = overlapCast(createdBody.apiSecret);
    expect(apiSecret).toMatch(/^osa_/);
    expect(JSON.stringify(createdBody)).not.toContain("secretHash");

    const wrongSecret = await app.request(
      "/v1/authentication/backend/registration-tokens",
      {
        method: "POST",
        headers: {
          authorization: "Bearer osa_wrong",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          applicationId,
          userId: "user-http-1",
          userName: "Ada",
          displayName: "Ada",
        }),
      },
    );
    expect(wrongSecret.status).toBe(401);

    const tokenResponse = await app.request(
      "/v1/authentication/backend/registration-tokens",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          applicationId,
          userId: "user-http-1",
          userName: "Ada",
          displayName: "Ada Lovelace",
          aliases: ["ada@example.com"],
        }),
      },
    );
    expect(tokenResponse.status).toBe(201);
    const registrationToken: string = overlapCast(
      overlapCast(await tokenResponse.json()).token,
    );

    const optionsResponse = await app.request(
      "/v1/authentication/public/register/options",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:5180",
          "content-type": "application/json",
        },
        body: JSON.stringify({ applicationId, token: registrationToken }),
      },
    );
    expect(optionsResponse.status).toBe(200);
    expect(optionsResponse.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5180",
    );
    const registrationOptions = overlapCast(await optionsResponse.json());

    const registrationChallenge: string = overlapCast(
      registrationOptions.challenge,
    );
    const registered = await app.request(
      "/v1/authentication/public/register/verify",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:5180",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          applicationId,
          response: {
            id: "credential-http-1",
            rawId: "credential-http-1",
            type: "public-key",
            clientExtensionResults: {},
            response: {
              clientDataJSON: clientData(registrationChallenge),
              attestationObject: "attestation",
              transports: ["internal"],
            },
          },
        }),
      },
    );
    expect(
      registered.status,
      JSON.stringify(await registered.clone().json()),
    ).toBe(201);

    const signinOptionsResponse = await app.request(
      "/v1/authentication/public/signin/options",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:5180",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          applicationId,
          mode: "alias",
          alias: "ADA@example.com",
        }),
      },
    );
    expect(signinOptionsResponse.status).toBe(200);
    const signinOptions = overlapCast(await signinOptionsResponse.json());
    const signinChallenge: string = overlapCast(signinOptions.challenge);
    const signedIn = await app.request(
      "/v1/authentication/public/signin/verify",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:5180",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          applicationId,
          response: {
            id: "credential-http-1",
            rawId: "credential-http-1",
            type: "public-key",
            clientExtensionResults: {},
            response: {
              clientDataJSON: clientData(signinChallenge),
              authenticatorData: "authenticator-data",
              signature: "signature",
            },
          },
        }),
      },
    );
    expect(signedIn.status).toBe(200);
    const signinToken: string = overlapCast(
      overlapCast(await signedIn.json()).token,
    );

    const exchange = () =>
      app.request("/v1/authentication/backend/signin/verify-token", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ applicationId, token: signinToken }),
      });
    const exchanged = await exchange();
    expect(exchanged.status).toBe(200);
    expect(await exchanged.json()).toEqual({
      success: true,
      userId: "user-http-1",
      purpose: "sign-in",
      type: "passkey",
      aliases: [],
    });
    expect((await exchange()).status).toBe(403);

    const users = await app.request(
      `/v1/authentication/applications/${applicationId}/users`,
      { headers: owner.auth },
    );
    expect(await users.json()).toMatchObject({
      users: [
        {
          userId: "user-http-1",
          aliases: [],
          credentials: [{ credentialId: "credential-http-1" }],
        },
      ],
    });

    const enabled = await app.request(
      `/v1/authentication/applications/${applicationId}`,
      {
        method: "PATCH",
        headers: { ...owner.auth, "content-type": "application/json" },
        body: JSON.stringify({
          manualTokensEnabled: true,
          magicLinksEnabled: true,
        }),
      },
    );
    expect(enabled.status).toBe(200);

    const manual = await app.request(
      "/v1/authentication/backend/signin/generate-token",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          applicationId,
          userId: "user-http-1",
          timeToLiveSeconds: 30,
        }),
      },
    );
    expect(manual.status).toBe(201);
    const manualToken: string = overlapCast(
      overlapCast(await manual.json()).token,
    );
    const manualExchange = await app.request(
      "/v1/authentication/backend/signin/verify-token",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ applicationId, token: manualToken }),
      },
    );
    expect(await manualExchange.json()).toMatchObject({
      success: true,
      userId: "user-http-1",
      type: "manual",
    });

    const aliases = await app.request("/v1/authentication/backend/aliases", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        applicationId,
        userId: "user-http-1",
        aliases: ["visible@example.com"],
        hashing: false,
      }),
    });
    expect(aliases.status).toBe(204);

    const credentials = await app.request(
      "/v1/authentication/backend/credentials/list",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ applicationId, userId: "user-http-1" }),
      },
    );
    expect(await credentials.json()).toMatchObject({
      credentials: [{ credentialId: "credential-http-1", rpId: "localhost" }],
    });

    const configuration = await app.request(
      "/v1/authentication/backend/auth-configurations",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          applicationId,
          purpose: "recover",
          timeToLiveSeconds: 45,
          userVerification: "required",
          hints: ["security-key"],
        }),
      },
    );
    expect(configuration.status).toBe(201);

    const magic = await app.request(
      "/v1/authentication/backend/magic-links/send",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          applicationId,
          emailAddress: "ada@example.com",
          userId: "user-http-1",
          urlTemplate: "http://localhost:5180/callback?token=$TOKEN",
        }),
      },
    );
    expect(magic.status).toBe(204);
    expect(ctx.mailer.outbox).toHaveLength(1);
    expect(ctx.mailer.outbox[0]?.body).toContain("ost_");

    const extraKey = await app.request(
      `/v1/authentication/applications/${applicationId}/api-keys`,
      { method: "POST", headers: owner.auth },
    );
    expect(extraKey.status).toBe(201);
    const extraKeyBody = overlapCast(await extraKey.json());
    const secondSecret: string = overlapCast(extraKeyBody.apiKey.secret);
    const initialKeyId: Array<{
      id: string;
    }> = overlapCast(overlapCast(createdBody.application).apiKeys);
    const locked = await app.request(
      `/v1/authentication/applications/${applicationId}/api-keys/${initialKeyId[0]?.id}`,
      {
        method: "PATCH",
        headers: { ...owner.auth, "content-type": "application/json" },
        body: JSON.stringify({ state: "locked" }),
      },
    );
    expect(locked.status).toBe(200);
    const secondSecretRequest = await app.request(
      "/v1/authentication/backend/credentials/list",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secondSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ applicationId, userId: "user-http-1" }),
      },
    );
    expect(secondSecretRequest.status).toBe(200);

    const rotated = await app.request(
      `/v1/authentication/applications/${applicationId}/rotate-secret`,
      { method: "POST", headers: owner.auth },
    );
    expect(rotated.status).toBe(200);
    const newSecret: string = overlapCast(
      overlapCast(await rotated.json()).apiSecret,
    );
    expect(newSecret).not.toBe(apiSecret);
    const oldSecretRequest = await app.request(
      "/v1/authentication/backend/registration-tokens",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          applicationId,
          userId: "user-2",
          userName: "Grace",
          displayName: "Grace",
        }),
      },
    );
    expect(oldSecretRequest.status).toBe(401);

    const removed = await app.request(
      `/v1/authentication/applications/${applicationId}/credentials/credential-http-1`,
      { method: "DELETE", headers: owner.auth },
    );
    expect(removed.status).toBe(200);
    const events = await app.request(
      `/v1/authentication/applications/${applicationId}/events`,
      { headers: owner.auth },
    );
    const eventsBody = overlapCast(await events.json());
    const eventTypes: Array<{
      eventType: string;
    }> = overlapCast(eventsBody.events);
    expect(eventTypes.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "authentication.application.created",
        "authentication.credential.registered",
        "authentication.signin.succeeded",
        "authentication.application.secret_rotated",
        "authentication.credential.revoked",
      ]),
    );
    expect(JSON.stringify(eventsBody).includes(apiSecret)).toBe(false);
  });

  it("rate-limits unauthenticated public ceremonies", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const attempt = () =>
      app.request("/v1/authentication/public/signin/options", {
        method: "POST",
        headers: {
          origin: "http://localhost:5180",
          "content-type": "application/json",
          "user-agent": "authentication-rate-test",
        },
        body: "{}",
      });
    for (let index = 0; index < 60; index += 1) {
      expect((await attempt()).status).toBe(400);
    }
    expect((await attempt()).status).toBe(429);
  });
});
