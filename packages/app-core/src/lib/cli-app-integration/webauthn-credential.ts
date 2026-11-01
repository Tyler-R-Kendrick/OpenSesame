/**
 * CLI approval passkey: a real WebAuthn credential, not a software ECDSA key
 * whose id is `base64url(SPKI)`. The daemon compares `rawId` to the id stored
 * at registration and verifies the P-256 signature as raw `r || s`.
 */

import { z } from "zod";
import {
  type WebStorage,
  credentials as hostCredentials,
  maybePage,
  publicKeyCredentialApi,
} from "../../ports.js";
import {
  b64urlDecode,
  b64urlEncode,
  formatCliAppHumanProofPasskey,
} from "./device-crypto.js";
import {
  authDataFromAttestation,
  coseFromAuthData,
  coseP256ToSpki,
  ecdsaDerToP1363,
  signCountOf,
  spkiToCose,
} from "./webauthn-cbor.js";
import { asBufferSource } from "@opensesame/os-domain";

export {
  coseP256ToSpki,
  ecdsaDerToP1363,
  encodeCoseP256,
} from "./webauthn-cbor.js";

const STORAGE_KEY = "opensesame.cli-app-webauthn.v1";

const storedSchema = z.object({
  credentialIdB64: z.string().min(1),
  coseKeyB64: z.string().min(1),
  publicKeySpkiB64: z.string().min(1),
});

export type CliAppWebAuthnCredential = z.infer<typeof storedSchema>;

export type CliAppPasskeyFailure = Readonly<{
  ok: false;
  code: string;
  message: string;
}>;

export type CliAppPasskeyRegistration = Readonly<{
  ok: true;
  credentialIdB64: string;
  coseKeyB64: string;
  publicKeySpkiB64: string;
  /** `oschip2:passkey:` assertion the register route verifies. */
  humanProof: string;
  signCount: number;
}>;

export type CliAppPasskeyReady =
  | "loading"
  | "ready"
  | "missing"
  | "unsupported";

type CredentialCeremony = Readonly<{
  create: (options: CredentialCreationOptions) => Promise<Credential | null>;
  get: (options: CredentialRequestOptions) => Promise<Credential | null>;
}>;

const UNSUPPORTED = failure(
  "webauthn_unsupported",
  "This browser cannot use a passkey, so CLI approval cannot succeed.",
);
const MISSING = failure(
  "passkey_missing",
  "No passkey is stored for CLI approval. Pair again in this browser before a request can be approved.",
);

function failure(code: string, message: string): CliAppPasskeyFailure {
  return { ok: false, code, message };
}

function bytesOf(source: BufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  return new Uint8Array(
    source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ),
  );
}

let storePort: (() => WebStorage) | null = null;

async function storage(): Promise<WebStorage> {
  if (!storePort) {
    const { localStore } = await import("../../ports.js");
    storePort = localStore;
    return localStore();
  }
  return storePort();
}

export function cliAppWebAuthnSupported(
  credentials: CredentialCeremony | null = defaultCredentials(),
): boolean {
  return (
    publicKeyCredentialApi() instanceof Function &&
    credentials?.create instanceof Function &&
    credentials?.get instanceof Function
  );
}
function defaultCredentials(): CredentialCeremony | null {
  const container = hostCredentials();
  if (!container?.create || !container.get) return null;
  return container;
}

export function readCliAppWebAuthnCredential(): CliAppWebAuthnCredential | null {
  if (!storePort) return null;
  try {
    const raw = storePort().getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveCliAppWebAuthnCredential(
  record: CliAppWebAuthnCredential,
): Promise<void> {
  const store = await storage();
  store.setItem(STORAGE_KEY, JSON.stringify(storedSchema.parse(record)));
}

export async function clearCliAppWebAuthnCredential(): Promise<void> {
  try {
    const store = await storage();
    store.removeItem(STORAGE_KEY);
  } catch {
    // Storage is unavailable. A later read stays empty.
  }
}

export function cliAppPasskeyReady(): CliAppPasskeyReady {
  if (!storePort) return "loading";
  if (!cliAppWebAuthnSupported()) return "unsupported";
  return readCliAppWebAuthnCredential() ? "ready" : "missing";
}

/** Load storage so a render can read passkey readiness without a round trip. */
export async function loadCliAppPasskeyReady(): Promise<CliAppPasskeyReady> {
  try {
    await storage();
  } catch {
    return "unsupported";
  }
  return cliAppPasskeyReady();
}

function isCredential(value: Credential | null): value is PublicKeyCredential {
  if (!value || value.type !== "public-key") return false;
  // SAFETY: the guard above checked value.type; the DOM only constructs that union member for PublicKeyCredential instances.
  const cred = value as PublicKeyCredential;
  return cred.rawId instanceof ArrayBuffer && cred.response instanceof Object;
}

function webauthnDomFailure(cause: unknown): CliAppPasskeyFailure {
  if (cause instanceof DOMException) {
    if (cause.name === "NotAllowedError" || cause.name === "AbortError") {
      return failure(
        "webauthn_cancelled",
        "Passkey confirmation was cancelled.",
      );
    }
    if (
      cause.name === "NotSupportedError" ||
      cause.name === "SecurityError" ||
      cause.name === "InvalidStateError"
    ) {
      return UNSUPPORTED;
    }
  }
  return failure("webauthn_failed", "The passkey step did not finish.");
}

function pageRpId(): string | null {
  const host = maybePage()?.location.hostname;
  return host ? host : null;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++)
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function publicKeyMaterial(response: AuthenticatorAttestationResponse): {
  spki: Uint8Array;
  cose: Uint8Array;
} | null {
  const fromBrowser = response.getPublicKey?.() ?? null;
  const spkiFromBrowser = fromBrowser ? bytesOf(fromBrowser) : null;
  const authData =
    response.getAuthenticatorData instanceof Function
      ? bytesOf(response.getAuthenticatorData())
      : authDataFromAttestation(bytesOf(response.attestationObject));
  const coseFromAuth = authData ? coseFromAuthData(authData) : null;
  const coseParsed = coseFromAuth ? coseP256ToSpki(coseFromAuth) : null;
  const cose =
    (coseParsed && coseFromAuth ? coseFromAuth : null) ??
    (spkiFromBrowser ? spkiToCose(spkiFromBrowser) : null);
  const spki = spkiFromBrowser ?? coseParsed;
  if (!spki || !cose) return null;
  return { spki, cose };
}

type AssertionWire =
  | CliAppPasskeyFailure
  | { ok: true; wire: string; signCount: number };

function assertionFromCredential(
  value: Credential | null,
  expectedId: Uint8Array,
): AssertionWire {
  if (!isCredential(value)) {
    return failure("webauthn_cancelled", "Passkey confirmation was cancelled.");
  }
  const rawId = bytesOf(value.rawId);
  if (!sameBytes(rawId, expectedId)) {
    return failure(
      "webauthn_credential_mismatch",
      "The passkey did not match the one stored at pairing.",
    );
  }
  // SAFETY: isCredential verified the PublicKeyCredential contract; its response is the browser's AuthenticatorAssertionResponse.
  const response = value.response as AuthenticatorAssertionResponse;
  if (
    !response.authenticatorData ||
    !response.clientDataJSON ||
    !response.signature
  ) {
    return failure(
      "webauthn_key_unusable",
      "The passkey proof was incomplete.",
    );
  }
  const authData = bytesOf(response.authenticatorData);
  if ((authData[32] & 0x04) === 0) {
    return failure(
      "webauthn_user_not_verified",
      "The passkey was not verified. Confirm it is you, then try again.",
    );
  }
  const raw = ecdsaDerToP1363(bytesOf(response.signature));
  const signCount = signCountOf(authData);
  if (!raw || signCount === null) {
    return failure(
      "webauthn_key_unusable",
      "The passkey signature could not be checked.",
    );
  }
  return {
    ok: true,
    signCount,
    wire: JSON.stringify({
      credentialIdB64: b64urlEncode(rawId),
      authenticatorDataB64: b64urlEncode(authData),
      clientDataJsonB64: b64urlEncode(bytesOf(response.clientDataJSON)),
      signatureB64: b64urlEncode(raw),
    }),
  };
}

export async function createCliAppPasskeyCredential(
  challenge: Uint8Array,
  credentials: CredentialCeremony | null = defaultCredentials(),
): Promise<CliAppPasskeyRegistration | CliAppPasskeyFailure> {
  if (!credentials) return UNSUPPORTED;
  const rpId = pageRpId();
  if (!rpId) return UNSUPPORTED;
  const userId = crypto.getRandomValues(new Uint8Array(16));
  let created: Credential | null;
  try {
    created = await credentials.create({
      publicKey: {
        challenge: asBufferSource(challenge),
        rp: { name: "OpenSesame", id: rpId },
        user: { id: userId, name: "cli-approval", displayName: "CLI approval" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 60_000,
        attestation: "none",
        authenticatorSelection: {
          userVerification: "required",
          residentKey: "preferred",
        },
      },
    });
  } catch (error) {
    return webauthnDomFailure(error);
  }
  if (!isCredential(created)) {
    return failure("webauthn_cancelled", "Passkey creation was cancelled.");
  }
  const rawId = bytesOf(created.rawId);
  // SAFETY: isCredential verified the created PublicKeyCredential contract; creation responses attest as AuthenticatorAttestationResponse.
  const attestation = created.response as AuthenticatorAttestationResponse;
  const material = publicKeyMaterial(attestation);
  if (!material) {
    return failure(
      "webauthn_key_unusable",
      "The passkey public key could not be read.",
    );
  }
  let asserted: Credential | null;
  try {
    asserted = await credentials.get({
      publicKey: {
        challenge: asBufferSource(challenge),
        timeout: 60_000,
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id: asBufferSource(rawId) }],
      },
    });
  } catch (error) {
    return webauthnDomFailure(error);
  }
  const proof = assertionFromCredential(asserted, rawId);
  if (!proof.ok) return proof;
  return {
    ok: true,
    credentialIdB64: b64urlEncode(rawId),
    coseKeyB64: b64urlEncode(material.cose),
    publicKeySpkiB64: b64urlEncode(material.spki),
    humanProof: `oschip2:passkey:${proof.wire}`,
    signCount: proof.signCount,
  };
}

export async function assertStoredCliAppPasskey(
  challenge: Uint8Array,
  credentials: CredentialCeremony | null = defaultCredentials(),
): Promise<
  { ok: true; proof: string; signCount: number } | CliAppPasskeyFailure
> {
  try {
    await storage();
  } catch {
    return UNSUPPORTED;
  }
  const stored = readCliAppWebAuthnCredential();
  if (!stored) return MISSING;
  if (!credentials) return UNSUPPORTED;
  const credentialId = b64urlDecode(stored.credentialIdB64);
  if (!credentialId) return MISSING;
  let asserted: Credential | null;
  try {
    asserted = await credentials.get({
      publicKey: {
        challenge: asBufferSource(challenge),
        timeout: 60_000,
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id: asBufferSource(credentialId) }],
      },
    });
  } catch (error) {
    return webauthnDomFailure(error);
  }
  const proof = assertionFromCredential(asserted, credentialId);
  if (!proof.ok) return proof;
  return {
    ok: true,
    proof: formatCliAppHumanProofPasskey(proof.wire),
    signCount: proof.signCount,
  };
}
