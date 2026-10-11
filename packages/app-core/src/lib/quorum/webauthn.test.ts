/**
 * Assertion verification, one rule at a time, against assertions a virtual key
 * actually signed: each test changes exactly one thing and expects exactly one
 * refusal.
 */
import { describe, expect, it } from "vitest";
import { fromB64url, toB64url } from "./bytes.js";
import { webauthnCeremony } from "./ceremony.js";
import type { AssertionProof, GuardianCredential } from "./types.js";
import {
  VirtualAuthenticator,
  type VirtualOptions,
  asContainer,
  p1363ToDer,
} from "./virtual-authenticator.test-support.js";
import {
  AssertionError,
  type VerifiedAssertion,
  derToP1363,
  spkiPoint,
  verifyAssertion,
} from "./webauthn.js";

const ORIGIN = "https://vault.example.test";
const RP_ID = "vault.example.test";
const CHALLENGE = crypto.getRandomValues(new Uint8Array(32));

async function enroll(
  alg: -7 | -8 = -7,
  options: Partial<VirtualOptions> = {},
) {
  const key = new VirtualAuthenticator({ origin: ORIGIN, alg, ...options });
  const ceremony = webauthnCeremony(asContainer(key.credentials));
  const registered = await ceremony.register({
    rpId: RP_ID,
    rpName: "t",
    userId: new Uint8Array(1),
    userName: "u",
    challenge: new Uint8Array(32),
    prfInput: new Uint8Array(8),
    excludeCredentialIds: [],
    requireUserVerification: false,
  });
  const credential: GuardianCredential = {
    credentialId: registered.credentialId,
    publicKey: registered.publicKey,
    alg: registered.alg,
    label: "k",
    prf: true,
    addedAt: "2026-10-10T12:00:00.000Z",
  };
  const assert = async (challenge = CHALLENGE): Promise<AssertionProof> =>
    (
      await ceremony.assert({
        rpId: RP_ID,
        challenge,
        allowCredentialIds: [],
        requireUserVerification: false,
      })
    ).proof;
  return { key, credential, assert };
}

const expectations = (over = {}) => ({
  challenge: CHALLENGE,
  rpId: RP_ID,
  origins: [ORIGIN],
  requireUserVerification: true,
  lastCounter: 0,
  ...over,
});

async function refusal(promise: Promise<VerifiedAssertion>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AssertionError) return error.code;
    throw error;
  }
  return "accepted";
}

describe("verifyAssertion", () => {
  it("accepts a genuine ES256 assertion and reads its counter", async () => {
    const { credential, assert } = await enroll();
    const verified = await verifyAssertion(
      credential,
      await assert(),
      expectations(),
    );
    expect(verified.counter).toBe(1);
    expect(verified.userVerified).toBe(true);
  });

  it("accepts a genuine Ed25519 assertion", async () => {
    const { credential, assert } = await enroll(-8);
    expect(
      (await verifyAssertion(credential, await assert(), expectations()))
        .counter,
    ).toBe(1);
  });

  it("verifies many ES256 signatures, whatever their integer encoding", async () => {
    const { credential, assert } = await enroll();
    for (let i = 0; i < 40; i += 1) {
      await verifyAssertion(
        credential,
        await assert(),
        expectations({ lastCounter: i }),
      );
    }
  });

  it("refuses a flipped signature bit", async () => {
    const { credential, assert } = await enroll();
    const proof = await assert();
    const bytes = fromB64url(proof.signature);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(
      await refusal(
        verifyAssertion(
          credential,
          { ...proof, signature: toB64url(bytes) },
          expectations(),
        ),
      ),
    ).toMatch(/signature/);
  });

  it("refuses an assertion signed by a different key", async () => {
    const a = await enroll();
    const b = await enroll();
    expect(
      await refusal(
        verifyAssertion(b.credential, await a.assert(), expectations()),
      ),
    ).toBe("signature");
  });

  it("refuses an Ed25519 signature from another key too", async () => {
    const a = await enroll(-8);
    const b = await enroll(-8);
    expect(
      await refusal(
        verifyAssertion(b.credential, await a.assert(), expectations()),
      ),
    ).toBe("signature");
  });

  it("refuses a different challenge", async () => {
    const { credential, assert } = await enroll();
    expect(
      await refusal(
        verifyAssertion(
          credential,
          await assert(),
          expectations({ challenge: new Uint8Array(32) }),
        ),
      ),
    ).toBe("challenge");
  });

  it("refuses an origin the circle does not list", async () => {
    const { credential, assert } = await enroll();
    expect(
      await refusal(
        verifyAssertion(
          credential,
          await assert(),
          expectations({ origins: ["https://other.example.test"] }),
        ),
      ),
    ).toBe("origin");
  });

  it("refuses authenticator data hashed for another RP ID, even when validly signed", async () => {
    const { key, credential, assert } = await enroll();
    key.set({ authDataRpId: "evil.example.test" });
    expect(
      await refusal(
        verifyAssertion(credential, await assert(), expectations()),
      ),
    ).toBe("rp_id");
  });

  it("refuses a touch with no presence flag", async () => {
    const { key, credential, assert } = await enroll();
    key.set({ forceFlags: 0x04 });
    expect(
      await refusal(
        verifyAssertion(credential, await assert(), expectations()),
      ),
    ).toBe("user_presence");
  });

  it("refuses presence without verification when the policy asks for it, accepts it when not", async () => {
    const { key, credential, assert } = await enroll();
    key.setUserVerified(false);
    const proof = await assert();
    expect(
      await refusal(verifyAssertion(credential, proof, expectations())),
    ).toBe("user_verification");
    expect(
      (
        await verifyAssertion(
          credential,
          proof,
          expectations({ requireUserVerification: false }),
        )
      ).userVerified,
    ).toBe(false);
  });

  it("refuses a counter that does not advance", async () => {
    const { credential, assert } = await enroll();
    const proof = await assert();
    expect(
      await refusal(
        verifyAssertion(credential, proof, expectations({ lastCounter: 1 })),
      ),
    ).toBe("counter");
    expect(
      await refusal(
        verifyAssertion(credential, proof, expectations({ lastCounter: 9 })),
      ),
    ).toBe("counter");
  });

  it("accepts a synced passkey whose counter stays at zero, but not one that drops to zero", async () => {
    const { credential, assert } = await enroll(-7, { counter: "zero" });
    const proof = await assert();
    expect(
      (await verifyAssertion(credential, proof, expectations())).counter,
    ).toBe(0);
    expect(
      await refusal(
        verifyAssertion(credential, proof, expectations({ lastCounter: 3 })),
      ),
    ).toBe("counter");
  });

  it("refuses client data that is not an authentication assertion", async () => {
    const { credential, assert } = await enroll();
    const proof = await assert();
    const data = JSON.parse(
      new TextDecoder().decode(fromB64url(proof.clientDataJSON)),
    );
    const create = toB64url(
      new TextEncoder().encode(
        JSON.stringify({ ...data, type: "webauthn.create" }),
      ),
    );
    expect(
      await refusal(
        verifyAssertion(
          credential,
          { ...proof, clientDataJSON: create },
          expectations(),
        ),
      ),
    ).toBe("type");
    const cross = toB64url(
      new TextEncoder().encode(JSON.stringify({ ...data, crossOrigin: true })),
    );
    expect(
      await refusal(
        verifyAssertion(
          credential,
          { ...proof, clientDataJSON: cross },
          expectations(),
        ),
      ),
    ).toBe("cross_origin");
    expect(
      await refusal(
        verifyAssertion(
          credential,
          {
            ...proof,
            clientDataJSON: toB64url(new TextEncoder().encode("nope")),
          },
          expectations(),
        ),
      ),
    ).toBe("client_data");
  });

  it("refuses authenticator data that is too short", async () => {
    const { credential, assert } = await enroll();
    const proof = await assert();
    expect(
      await refusal(
        verifyAssertion(
          credential,
          { ...proof, authenticatorData: toB64url(new Uint8Array(10)) },
          expectations(),
        ),
      ),
    ).toBe("authenticator_data");
  });
});

describe("key and signature encodings", () => {
  it("accepts only a plain ES256 or Ed25519 SubjectPublicKeyInfo", async () => {
    const { credential } = await enroll();
    const spki = fromB64url(credential.publicKey);
    expect(spkiPoint(spki, -7)).toHaveLength(65);
    expect(() => spkiPoint(spki.slice(0, 80), -7)).toThrow(AssertionError);
    expect(() => spkiPoint(spki, -8)).toThrow(AssertionError);
    const ed = await enroll(-8);
    expect(spkiPoint(fromB64url(ed.credential.publicKey), -8)).toHaveLength(32);
  });

  it("round-trips DER and P1363 including leading-zero and high-bit integers", () => {
    const cases = [
      new Uint8Array(64).fill(0x80),
      Uint8Array.from({ length: 64 }, (_, i) =>
        i < 32 ? (i === 0 ? 0 : 0xff) : i === 32 ? 0 : 1,
      ),
      Uint8Array.from({ length: 64 }, (_, i) => (i === 31 || i === 63 ? 1 : 0)),
      crypto.getRandomValues(new Uint8Array(64)),
    ];
    for (const raw of cases) {
      expect(derToP1363(p1363ToDer(raw))).toEqual(raw);
    }
  });

  it("refuses malformed DER", () => {
    expect(() => derToP1363(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toThrow(
      AssertionError,
    );
    expect(() => derToP1363(new Uint8Array([0x31, 0x00]))).toThrow(
      AssertionError,
    );
    expect(() => derToP1363(new Uint8Array(0))).toThrow(AssertionError);
  });
});
