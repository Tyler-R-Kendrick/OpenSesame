import type { AuthenticationApplication } from "@opensesame/os-domain";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryAuthenticationServiceStores } from "../../../database/src/index.js";
import {
  type AuthenticationServiceError,
  DEFAULT_AUTHENTICATION_CONFIGURATIONS,
  createAuthenticationService,
  mintAuthenticationApplicationSecret,
} from "../authentication-service.js";
import { simpleWebAuthnSeams } from "../simplewebauthn.js";

function clientData(challenge: string): string {
  return Buffer.from(
    JSON.stringify({
      type: "webauthn.create",
      challenge,
      origin: "https://login.example.com",
    }),
  ).toString("base64url");
}

function registrationResponse(challenge: string): RegistrationResponseJSON {
  return {
    id: "credential-1",
    rawId: "credential-1",
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData(challenge),
      attestationObject: "attestation",
      transports: ["internal"],
    },
  };
}

function authenticationResponse(challenge: string): AuthenticationResponseJSON {
  return {
    id: "credential-1",
    rawId: "credential-1",
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData(challenge),
      authenticatorData: "authenticator-data",
      signature: "signature",
    },
  };
}

async function setup() {
  const stores = createMemoryAuthenticationServiceStores();
  const secret = mintAuthenticationApplicationSecret();
  const now = new Date("2026-08-26T12:00:00Z");
  const application: AuthenticationApplication = {
    id: "authapp_one",
    ownerPrincipalId: "prn_owner",
    displayName: "Example",
    rpId: "example.com",
    origins: ["https://login.example.com"],
    secretHash: secret.secretHash,
    secretPrefix: secret.secretPrefix,
    apiKeys: [
      {
        id: "authkey-test",
        secretHash: secret.secretHash,
        secretPrefix: secret.secretPrefix,
        state: "active",
        createdAt: now.toISOString(),
      },
    ],
    configurations: DEFAULT_AUTHENTICATION_CONFIGURATIONS,
    manualTokensEnabled: true,
    magicLinksEnabled: true,
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
  await stores.applications.create(application);
  return {
    stores,
    service: createAuthenticationService(stores, () => now),
  };
}

describe("authentication service", () => {
  afterEach(() => vi.restoreAllMocks());

  it("registers, supports every sign-in mode, and exchanges a result once", async () => {
    const { service } = await setup();
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
        origin: "https://login.example.com",
        rpID: "example.com",
        userVerified: true,
        attestationObject: new Uint8Array(),
        credential: {
          id: "credential-1",
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
        credentialID: "credential-1",
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: "https://login.example.com",
        rpID: "example.com",
      },
    });

    const registration = await service.createRegistrationToken({
      applicationId: "authapp_one",
      userId: "user-1",
      userName: "Ada",
      displayName: "Ada Lovelace",
      aliases: ["ADA@EXAMPLE.COM"],
    });
    const options = await service.registrationOptions({
      applicationId: "authapp_one",
      token: registration.token,
      origin: "https://login.example.com",
    });
    await expect(
      service.verifyRegistration({
        applicationId: "authapp_one",
        response: registrationResponse(options.challenge),
      }),
    ).resolves.toEqual({ userId: "user-1", credentialId: "credential-1" });

    for (const input of [
      { mode: "autofill" as const },
      { mode: "discoverable" as const },
      { mode: "alias" as const, alias: "ada@example.com" },
      { mode: "user_id" as const, userId: "user-1" },
    ]) {
      const authOptions = await service.authenticationOptions({
        applicationId: "authapp_one",
        origin: "https://login.example.com",
        ...input,
      });
      expect(authOptions.challenge).toBeTruthy();
    }

    const authOptions = await service.authenticationOptions({
      applicationId: "authapp_one",
      origin: "https://login.example.com",
      mode: "alias",
      alias: "ada@example.com",
    });
    const result = await service.verifyAuthentication({
      applicationId: "authapp_one",
      response: authenticationResponse(authOptions.challenge),
    });
    await expect(
      service.verifyToken("authapp_one", result.token),
    ).resolves.toEqual({
      success: true,
      userId: "user-1",
      purpose: "sign-in",
      type: "passkey",
      aliases: [],
    });
    await expect(
      service.verifyToken("authapp_one", result.token),
    ).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("binds registration tokens and challenges to one app and origin", async () => {
    const { service } = await setup();
    const registration = await service.createRegistrationToken({
      applicationId: "authapp_one",
      userId: "user-1",
      userName: "Ada",
      displayName: "Ada",
    });
    await expect(
      service.registrationOptions({
        applicationId: "authapp_one",
        token: registration.token,
        origin: "https://evil.example",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AuthenticationServiceError>>({
        code: "origin_not_allowed",
      }),
    );
    await expect(
      service.registrationOptions({
        applicationId: "authapp_other",
        token: registration.token,
        origin: "https://login.example.com",
      }),
    ).rejects.toMatchObject({ code: "application_not_found" });
  });
});
