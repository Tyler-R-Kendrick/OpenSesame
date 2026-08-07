import { describe, expect, it } from "vitest";
import {
  createMemoryChallengeStore,
  createSimpleWebAuthnVerifyFn,
  issueAuthenticationChallenge,
  issueRegistrationChallenge,
  verifyRegistrationAttestation,
} from "../webauthn.js";
import type { PasskeyAssertion, PasskeyCredential } from "../passkey.js";

describe("webauthn challenge store", () => {
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
