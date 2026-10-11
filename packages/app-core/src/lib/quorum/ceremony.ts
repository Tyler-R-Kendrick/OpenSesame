/**
 * The two WebAuthn ceremonies a guardian runs, over the page's credentials
 * container (`requireCredentials()` in the browser, a double in tests):
 *
 * - `register`: make a credential, ask for the PRF extension, and read back
 *   its SubjectPublicKeyInfo and algorithm so the policy can hold the key;
 * - `assert`: sign a challenge and, when asked, evaluate PRF on an input.
 *
 * Results are read structurally, never by `instanceof`, so this runs on any
 * host that hands back the same shape. The PRF output is returned to the
 * caller and is the caller's to wipe: it is the key a share is wrapped under.
 */

import { overlapCast } from "@opensesame/os-domain";
import { requireCredentials } from "../../ports.js";
import {
  PrfCeremonyError,
  type PrfCeremonyErrorCode,
  assertUsablePrfOutput,
} from "../vault/protection/adapters/webauthn-prf-output.js";
import { fromB64url, toB64url } from "./bytes.js";
import type { AssertionProof } from "./types.js";

export type Container = Pick<CredentialsContainer, "create" | "get">;

export type RegisterInput = Readonly<{
  rpId: string;
  rpName: string;
  userId: Uint8Array;
  userName: string;
  challenge: Uint8Array;
  /** Evaluate PRF on this at creation too, where the key can (hmac-secret-mc). */
  prfInput: Uint8Array;
  excludeCredentialIds: readonly string[];
  requireUserVerification: boolean;
}>;

export type Registered = Readonly<{
  credentialId: string;
  publicKey: string;
  alg: -7 | -8;
  /** The extension ran. Whether its output is stable is proved by an assertion. */
  prfEnabled: boolean;
}>;

export type AssertInput = Readonly<{
  rpId: string;
  challenge: Uint8Array;
  allowCredentialIds: readonly string[];
  requireUserVerification: boolean;
  /** Evaluate PRF on this input; the output comes back as `prfOutput`. */
  prfInput?: Uint8Array;
  /** A key with no PRF answers with `prfOutput: null` instead of failing. */
  prfOptional?: boolean;
}>;

export type Asserted = Readonly<{
  credentialId: string;
  proof: AssertionProof;
  /** The PRF output when one was asked for. Wipe it after use. */
  prfOutput: Uint8Array | null;
}>;

export type Ceremony = Readonly<{
  register(input: RegisterInput): Promise<Registered>;
  assert(input: AssertInput): Promise<Asserted>;
}>;

function bytesOf(source: BufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(
        source.buffer,
        source.byteOffset,
        source.byteLength,
      ).slice()
    : new Uint8Array(source).slice();
}

function allow(ids: readonly string[]): PublicKeyCredentialDescriptor[] {
  return ids.map((id) => ({ type: "public-key", id: fromB64url(id) }));
}

/**
 * What the container handed back, as the DOM types it. The browser is the
 * authority on its own credentials; this only refuses a null or a credential
 * of another type before the rest of the code reads its fields.
 */
function publicKeyCredential(
  credential: Credential | null,
  code: PrfCeremonyErrorCode,
  message: string,
): PublicKeyCredential {
  if (credential === null || credential.type !== "public-key") {
    throw new PrfCeremonyError(code, message);
  }
  const typed: PublicKeyCredential = overlapCast(credential);
  return typed;
}

function readRegistered(credential: Credential | null): Registered {
  const created = publicKeyCredential(
    credential,
    "unsupported",
    "no credential was created",
  );
  const response: AuthenticatorAttestationResponse = overlapCast(
    created.response,
  );
  const alg = response.getPublicKeyAlgorithm();
  const key = response.getPublicKey();
  if (key === null) {
    throw new PrfCeremonyError(
      "unsupported",
      "this browser does not expose the credential's public key",
    );
  }
  if (alg !== -7 && alg !== -8) {
    throw new PrfCeremonyError(
      "unsupported",
      "the key must be ES256 or Ed25519",
    );
  }
  return {
    credentialId: toB64url(created.rawId),
    publicKey: toB64url(key),
    alg,
    prfEnabled: created.getClientExtensionResults().prf?.enabled === true,
  };
}

function readAsserted(
  credential: Credential | null,
  wantPrf: boolean,
  prfOptional: boolean,
): Asserted {
  const got = publicKeyCredential(
    credential,
    "canceled",
    "no assertion was made",
  );
  const response: AuthenticatorAssertionResponse = overlapCast(got.response);
  const first = got.getClientExtensionResults().prf?.results?.first;
  let prfOutput: Uint8Array | null = null;
  if (wantPrf && first) {
    const output = bytesOf(first);
    assertUsablePrfOutput(output.buffer);
    prfOutput = output;
  } else if (wantPrf && !prfOptional) {
    throw new PrfCeremonyError(
      "prf_missing_output",
      "this key did not return a PRF result",
    );
  }
  return {
    credentialId: toB64url(got.rawId),
    proof: {
      clientDataJSON: toB64url(response.clientDataJSON),
      authenticatorData: toB64url(response.authenticatorData),
      signature: toB64url(response.signature),
    },
    prfOutput,
  };
}

/** The ceremonies over a credentials container (the page's own by default). */
export function webauthnCeremony(
  container: Container = requireCredentials(),
): Ceremony {
  return {
    async register(input) {
      const created = await container.create({
        publicKey: {
          rp: { id: input.rpId, name: input.rpName },
          user: {
            id: input.userId,
            name: input.userName,
            displayName: input.userName,
          },
          challenge: input.challenge,
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -8 },
          ],
          excludeCredentials: allow(input.excludeCredentialIds),
          authenticatorSelection: {
            userVerification: input.requireUserVerification
              ? "required"
              : "preferred",
            residentKey: "discouraged",
          },
          attestation: "none",
          extensions: { prf: { eval: { first: input.prfInput } } },
        },
      });
      return readRegistered(created);
    },
    async assert(input) {
      const publicKey: PublicKeyCredentialRequestOptions = {
        rpId: input.rpId,
        challenge: input.challenge,
        allowCredentials: allow(input.allowCredentialIds),
        userVerification: input.requireUserVerification
          ? "required"
          : "preferred",
      };
      if (input.prfInput) {
        publicKey.extensions = { prf: { eval: { first: input.prfInput } } };
      }
      const got = await container.get({ publicKey });
      return readAsserted(
        got,
        input.prfInput !== undefined,
        input.prfOptional === true,
      );
    },
  };
}
