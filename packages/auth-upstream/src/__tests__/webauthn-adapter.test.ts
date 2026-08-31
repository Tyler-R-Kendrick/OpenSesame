import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PasskeyAssertion, PasskeyCredential } from "../passkey.js";
import { simpleWebAuthnSeams } from "../simplewebauthn.js";
import {
  MAX_OUTSTANDING_CHALLENGES,
  createMemoryChallengeStore,
  createSimpleWebAuthnVerifyFn,
  issueTransactionChallenge,
  issueAuthenticationChallenge,
  issueRegistrationChallenge,
  verifyRegistrationAttestation,
} from "../webauthn.js";

const mockVerifyRegistration = vi.fn();
const mockVerifyAuthentication = vi.fn();

const rp = { rpID: "localhost", origin: "http://127.0.0.1:8788" };

function registrationResponse(
  clientData: JsonObject,
): RegistrationResponseJSON {
  return {
    id: "cred",
    rawId: "cred",
    type: "public-key",
    response: {
      clientDataJSON: Buffer.from(JSON.stringify(clientData)).toString(
        "base64url",
      ),
      attestationObject: Buffer.from("x").toString("base64url"),
    },
    clientExtensionResults: {},
  };
}

function assertionFor(challenge: string): PasskeyAssertion {
  return {
    credentialId: "cred1",
    clientDataJSON: new TextEncoder().encode(
      JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin: rp.origin,
      }),
    ),
    authenticatorData: new Uint8Array([0]),
    signature: new Uint8Array([1]),
  };
}

const credential: PasskeyCredential = {
  credentialId: "cred1",
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 0,
  principalId: "prn_x",
};

beforeEach(() => {
  mockVerifyRegistration.mockReset();
  mockVerifyAuthentication.mockReset();
  simpleWebAuthnSeams.verifyRegistrationResponse = overlapCast(
    mockVerifyRegistration,
  );
  simpleWebAuthnSeams.verifyAuthenticationResponse = overlapCast(
    mockVerifyAuthentication,
  );
});

describe("verifyRegistrationAttestation", () => {
  it("returns null when clientDataJSON is not parseable JSON", async () => {
    const store = createMemoryChallengeStore();
    const result = await verifyRegistrationAttestation(
      store,
      rp,
      {
        id: "cred",
        rawId: "cred",
        type: "public-key",
        response: {
          clientDataJSON: Buffer.from("not json at all").toString("base64url"),
          attestationObject: Buffer.from("x").toString("base64url"),
        },
        clientExtensionResults: {},
      },
      "prn_reg",
    );
    expect(result).toBeNull();
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  it("returns null when the client data carries no string challenge", async () => {
    const store = createMemoryChallengeStore();
    for (const clientData of [{}, { challenge: 42 }]) {
      const result = await verifyRegistrationAttestation(
        store,
        rp,
        registrationResponse(clientData),
        "prn_reg",
      );
      expect(result).toBeNull();
    }
  });

  it("returns null when the challenge was issued for authentication", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueAuthenticationChallenge(store, rp, {
      principalId: "prn_reg",
    });
    const result = await verifyRegistrationAttestation(
      store,
      rp,
      registrationResponse({ challenge }),
      "prn_reg",
    );
    expect(result).toBeNull();
  });

  it("returns null when the challenge was issued to another principal", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueRegistrationChallenge(store, rp, {
      principalId: "prn_someone_else",
    });
    const result = await verifyRegistrationAttestation(
      store,
      rp,
      registrationResponse({ challenge }),
      "prn_reg",
    );
    expect(result).toBeNull();
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  it("returns credential material on a verified attestation", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueRegistrationChallenge(store, rp, {
      principalId: "prn_reg",
    });
    mockVerifyRegistration.mockResolvedValue(
      overlapCast({
        verified: true,
        registrationInfo: {
          credential: {
            id: "cred-id",
            publicKey: new Uint8Array([4, 5, 6]),
            counter: 3,
          },
        },
      }),
    );

    const result = await verifyRegistrationAttestation(
      store,
      rp,
      registrationResponse({ challenge }),
      "prn_reg",
    );
    expect(result).toEqual({
      credentialId: "cred-id",
      publicKey: new Uint8Array([4, 5, 6]),
      counter: 3,
    });
    // User verification stays mandatory on the wrapped call.
    expect(mockVerifyRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ requireUserVerification: true }),
    );
  });

  it("returns null when verification fails or yields no credential", async () => {
    const store = createMemoryChallengeStore();

    const first = await issueRegistrationChallenge(store, rp, {
      principalId: "prn_reg",
    });
    mockVerifyRegistration.mockResolvedValueOnce(
      overlapCast({ verified: false }),
    );
    expect(
      await verifyRegistrationAttestation(
        store,
        rp,
        registrationResponse({ challenge: first.challenge }),
        "prn_reg",
      ),
    ).toBeNull();

    const second = await issueRegistrationChallenge(store, rp, {
      principalId: "prn_reg",
    });
    mockVerifyRegistration.mockResolvedValueOnce(
      overlapCast({
        verified: true,
        registrationInfo: undefined,
      }),
    );
    expect(
      await verifyRegistrationAttestation(
        store,
        rp,
        registrationResponse({ challenge: second.challenge }),
        "prn_reg",
      ),
    ).toBeNull();
  });

  it("returns null when the library throws on a malformed attestation", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueRegistrationChallenge(store, rp, {
      principalId: "prn_reg",
    });
    mockVerifyRegistration.mockRejectedValueOnce(
      new Error("malformed attestationObject"),
    );
    expect(
      await verifyRegistrationAttestation(
        store,
        rp,
        registrationResponse({ challenge }),
        "prn_reg",
      ),
    ).toBeNull();
  });
});

describe("createSimpleWebAuthnVerifyFn", () => {
  it("returns false when clientDataJSON is not parseable JSON", async () => {
    const store = createMemoryChallengeStore();
    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    const result = await verify(
      { ...assertionFor("x"), clientDataJSON: new Uint8Array([0xff, 0x00]) },
      credential,
    );
    expect(result).toBe(false);
  });

  it("returns false when the client data carries no string challenge", async () => {
    const store = createMemoryChallengeStore();
    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    const assertion: PasskeyAssertion = {
      ...assertionFor("x"),
      clientDataJSON: new TextEncoder().encode(
        JSON.stringify({ type: "webauthn.get", challenge: 42 }),
      ),
    };
    expect(await verify(assertion, credential)).toBe(false);
  });

  it("returns false when the challenge was issued for registration", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueRegistrationChallenge(store, rp, {
      principalId: "prn_x",
    });
    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    expect(await verify(assertionFor(challenge), credential)).toBe(false);
  });

  it("adversarial: an approval ceremony's assertion is not a second factor", async () => {
    // The two ceremonies are indistinguishable on the wire — both prove this
    // person, this authenticator, just now — so only the challenge's purpose
    // separates them. Without this, a page could mint an approval ceremony,
    // have somebody touch their key for something that looked harmless, and
    // redeem the assertion at /v1/mfa/passkey/assert as a login.
    const store = createMemoryChallengeStore();
    const { challenge } = await issueTransactionChallenge(store, rp, {
      principalId: "prn_x",
      transactionDigest: "v1:some-approval",
    });
    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    // The sign-in path does not name a purpose, so it gets the narrow one.
    expect(await verify(assertionFor(challenge), credential)).toBe(false);
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
  });

  it("adversarial: a sign-in challenge cannot be spent on an approval", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueAuthenticationChallenge(store, rp, {
      principalId: "prn_x",
    });
    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    expect(
      await verify(
        { ...assertionFor(challenge), expectedPurpose: "transaction" },
        credential,
      ),
    ).toBe(false);
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
  });

  it("contract: an approval ceremony verifies when that is what was asked for", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueTransactionChallenge(store, rp, {
      principalId: "prn_x",
      transactionDigest: "v1:some-approval",
    });
    mockVerifyAuthentication.mockResolvedValue(
      overlapCast({ verified: true, authenticationInfo: { newCounter: 3 } }),
    );
    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    await expect(
      verify(
        { ...assertionFor(challenge), expectedPurpose: "transaction" },
        credential,
      ),
    ).resolves.toEqual({ ok: true, newCounter: 3 });
  });

  it("returns false when the challenge is bound to another principal", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueAuthenticationChallenge(store, rp, {
      principalId: "prn_someone_else",
    });
    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    expect(await verify(assertionFor(challenge), credential)).toBe(false);
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
  });

  it("verifies and hands back the fresh counter on success", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueAuthenticationChallenge(store, rp, {
      principalId: "prn_x",
    });
    mockVerifyAuthentication.mockResolvedValue(
      overlapCast({
        verified: true,
        authenticationInfo: { newCounter: 9 },
      }),
    );

    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    await expect(verify(assertionFor(challenge), credential)).resolves.toEqual({
      ok: true,
      newCounter: 9,
    });
    expect(mockVerifyAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
      }),
    );
  });

  it("accepts unbound challenges against any credential principal", async () => {
    const store = createMemoryChallengeStore();
    // No principalId: the challenge is not session-bound.
    const { challenge } = await issueAuthenticationChallenge(store, rp);
    mockVerifyAuthentication.mockResolvedValue(
      overlapCast({
        verified: true,
        authenticationInfo: { newCounter: 1 },
      }),
    );

    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    await expect(verify(assertionFor(challenge), credential)).resolves.toEqual({
      ok: true,
      newCounter: 1,
    });
  });

  it("returns ok with an undefined counter when the library omits it", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueAuthenticationChallenge(store, rp, {
      principalId: "prn_x",
    });
    mockVerifyAuthentication.mockResolvedValue(
      overlapCast({
        verified: true,
        authenticationInfo: undefined,
      }),
    );

    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    await expect(verify(assertionFor(challenge), credential)).resolves.toEqual({
      ok: true,
      newCounter: undefined,
    });
  });

  it("returns false when the library reports the assertion unverified", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueAuthenticationChallenge(store, rp, {
      principalId: "prn_x",
    });
    mockVerifyAuthentication.mockResolvedValue(
      overlapCast({ verified: false }),
    );

    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    expect(await verify(assertionFor(challenge), credential)).toBe(false);
  });

  it("returns false when the library throws on a malformed assertion", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueAuthenticationChallenge(store, rp, {
      principalId: "prn_x",
    });
    mockVerifyAuthentication.mockRejectedValueOnce(new Error("bad signature"));

    const verify = createSimpleWebAuthnVerifyFn(rp, store);
    expect(await verify(assertionFor(challenge), credential)).toBe(false);
  });
});

describe("challenge issuance options", () => {
  it("embeds allowCredentials with the full transport list when provided", async () => {
    const store = createMemoryChallengeStore();
    const { options } = await issueAuthenticationChallenge(store, rp, {
      principalId: "prn_x",
      allowCredentials: [{ id: "cred1" }],
    });
    expect(options.allowCredentials).toEqual([
      {
        id: "cred1",
        type: "public-key",
        transports: ["internal", "hybrid", "usb", "ble", "nfc"],
      },
    ]);
  });

  it("omits allowCredentials when the list is empty", async () => {
    const store = createMemoryChallengeStore();
    const { options } = await issueAuthenticationChallenge(store, rp, {
      allowCredentials: [],
    });
    expect(options.allowCredentials ?? []).toEqual([]);
  });

  it("uses the supplied user name and display name for registration", async () => {
    const store = createMemoryChallengeStore();
    const { options } = await issueRegistrationChallenge(store, rp, {
      principalId: "prn_reg",
      userName: "ada@example.com",
      userDisplayName: "Ada",
    });
    expect(options.user.name).toBe("ada@example.com");
    expect(options.user.displayName).toBe("Ada");
    expect(options.attestation).toBe("direct");
  });

  it("falls back to the principal id as the user name", async () => {
    const store = createMemoryChallengeStore();
    const { options } = await issueRegistrationChallenge(store, rp, {
      principalId: "prn_reg",
    });
    expect(options.user.name).toBe("prn_reg");
    expect(options.user.displayName).toBe("prn_reg");
  });
});

describe("challenge store expiry and eviction edges", () => {
  it("refuses a challenge that expired after issuance", async () => {
    const store = createMemoryChallengeStore();
    store.set("short-lived", {
      principalId: null,
      purpose: "authentication",
      expiresAt: Date.now() + 5,
    });
    // No intervening set() prunes the row, so consume itself must reject it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.consume("short-lived")).toBeUndefined();
  });

  it("falls back to evicting the global oldest when the issuer has none stored", () => {
    const store = createMemoryChallengeStore();
    const expiresAt = Date.now() + 60_000;
    // Fill the store to capacity with another principal's challenges.
    for (let i = 0; i < MAX_OUTSTANDING_CHALLENGES; i += 1) {
      store.set(`other-${i}`, {
        principalId: "prn_other",
        purpose: "authentication",
        expiresAt,
      });
    }
    // A new principal with no challenge of its own to sacrifice.
    store.set("newcomer", {
      principalId: "prn_new",
      purpose: "authentication",
      expiresAt,
    });

    expect(store.consume("other-0")).toBeUndefined();
    expect(store.consume("newcomer")).toBeDefined();
  });
});
