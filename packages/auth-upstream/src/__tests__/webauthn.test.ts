import { describe, expect, it } from "vitest";
import {
  MAX_OUTSTANDING_CHALLENGES,
  createMemoryChallengeStore,
  createSimpleWebAuthnVerifyFn,
  issueAuthenticationChallenge,
  issueRegistrationChallenge,
  verifyRegistrationAttestation,
} from "../webauthn.js";
import type { PasskeyAssertion, PasskeyCredential } from "../passkey.js";

describe("webauthn challenge store", () => {
  it("drops expired rows and refuses to grow without bound", () => {
    const store = createMemoryChallengeStore();
    // An expired row must not survive the next issuance.
    store.set("stale", {
      principalId: null,
      purpose: "authentication",
      expiresAt: Date.now() - 1,
    });
    store.set("fresh", {
      principalId: null,
      purpose: "authentication",
      expiresAt: Date.now() + 60_000,
    });
    expect(store.consume("stale")).toBeUndefined();
    expect(store.consume("fresh")).toBeDefined();

    // Issuing is cheap for the caller, so the store caps itself.
    const expiresAt = Date.now() + 60_000;
    for (let i = 0; i <= MAX_OUTSTANDING_CHALLENGES; i += 1) {
      store.set(`c${i}`, { principalId: null, purpose: "authentication", expiresAt });
    }
    expect(store.consume("c0")).toBeUndefined();
    expect(store.consume(`c${MAX_OUTSTANDING_CHALLENGES}`)).toBeDefined();
  });

  it("does not let one principal evict another's outstanding challenge", () => {
    const store = createMemoryChallengeStore();
    const expiresAt = Date.now() + 60_000;
    store.set("victim-challenge", {
      principalId: "prn_victim",
      purpose: "authentication",
      expiresAt,
    });

    // A principal asking for challenges in bulk should crowd out its own, not
    // somebody else's ceremony.
    for (let i = 0; i <= MAX_OUTSTANDING_CHALLENGES * 2; i += 1) {
      store.set(`flood-${i}`, {
        principalId: "prn_flooder",
        purpose: "authentication",
        expiresAt,
      });
    }

    expect(store.consume("victim-challenge")).toBeDefined();
  });

  it("issues and consumes a one-time challenge", async () => {
    const store = createMemoryChallengeStore();
    const { challenge } = await issueAuthenticationChallenge(
      store,
      { rpID: "localhost", origin: "http://127.0.0.1:8788" },
      { principalId: "prn_test" },
    );
    expect(challenge.length).toBeGreaterThan(8);
    const meta = store.consume(challenge);
    expect(meta?.principalId).toBe("prn_test");
    expect(meta?.purpose).toBe("authentication");
    expect(store.consume(challenge)).toBeUndefined();
  });

  it("issues registration challenges distinct from authentication", async () => {
    const store = createMemoryChallengeStore();
    const rp = { rpID: "localhost", origin: "http://127.0.0.1:8788" };
    const { challenge } = await issueRegistrationChallenge(store, rp, {
      principalId: "prn_reg",
    });
    expect(challenge.length).toBeGreaterThan(8);
    const meta = store.consume(challenge);
    expect(meta?.purpose).toBe("registration");
    expect(meta?.principalId).toBe("prn_reg");
  });

  it("demands user verification in both ceremonies", async () => {
    const store = createMemoryChallengeStore();
    const rp = { rpID: "localhost", origin: "http://127.0.0.1:8788" };

    // A passkey is the production MFA factor here. An assertion that skipped user
    // verification proves possession of the authenticator and nothing more, so
    // "preferred" would let one factor answer for two.
    const auth = await issueAuthenticationChallenge(store, rp, {
      principalId: "prn_uv",
    });
    expect(auth.options.userVerification).toBe("required");

    const registration = await issueRegistrationChallenge(store, rp, {
      principalId: "prn_uv",
    });
    expect(registration.options.authenticatorSelection?.userVerification).toBe(
      "required",
    );
  });

  it("rejects registration attestation without a matching challenge", async () => {
    const store = createMemoryChallengeStore();
    const rp = { rpID: "localhost", origin: "http://127.0.0.1:8788" };
    const result = await verifyRegistrationAttestation(
      store,
      rp,
      {
        id: "cred",
        rawId: "cred",
        type: "public-key",
        response: {
          clientDataJSON: Buffer.from(
            JSON.stringify({
              type: "webauthn.create",
              challenge: "never-issued",
              origin: rp.origin,
            }),
          ).toString("base64url"),
          attestationObject: Buffer.from("x").toString("base64url"),
        },
        clientExtensionResults: {},
      },
      "prn_reg",
    );
    expect(result).toBeNull();
  });

  it("rejects assertion without a matching issued challenge", async () => {
    const store = createMemoryChallengeStore();
    const verify = createSimpleWebAuthnVerifyFn(
      { rpID: "localhost", origin: "http://127.0.0.1:8788" },
      store,
    );
    const credential: PasskeyCredential = {
      credentialId: "cred1",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      principalId: "prn_x",
    };
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: "webauthn.get",
        challenge: "never-issued",
        origin: "http://127.0.0.1:8788",
      }),
    );
    const assertion: PasskeyAssertion = {
      credentialId: "cred1",
      clientDataJSON,
      authenticatorData: new Uint8Array([0]),
      signature: new Uint8Array([1]),
    };
    await expect(verify(assertion, credential)).resolves.toBe(false);
  });
});
