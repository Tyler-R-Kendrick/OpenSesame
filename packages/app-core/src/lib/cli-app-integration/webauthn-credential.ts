/**
 * CLI approval passkey: a real WebAuthn credential, not a software ECDSA key
 * whose id is `base64url(SPKI)`. The daemon compares `rawId` to the id stored
 * at registration and verifies the P-256 signature as raw `r || s`.
 */

import { z } from "zod";
import type { WebStorage } from "../../ports.js";
import {
  b64urlDecode,
  b64urlEncode,
  formatCliAppHumanProofPasskey,
} from "./device-crypto.js";

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

const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

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
  const Cred = (globalThis as { PublicKeyCredential?: unknown })
    .PublicKeyCredential;
  return (
    typeof Cred === "function" &&
    typeof credentials?.create === "function" &&
    typeof credentials?.get === "function"
  );
}

function defaultCredentials(): CredentialCeremony | null {
  const credentials = globalThis.navigator?.credentials;
  if (!credentials?.create || !credentials.get) return null;
  return credentials;
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

type CborValue =
  | { kind: "uint"; n: number }
  | { kind: "nint"; n: number }
  | { kind: "bytes"; b: Uint8Array }
  | { kind: "text"; s: string }
  | { kind: "array"; items: CborValue[] }
  | { kind: "map"; entries: ReadonlyArray<readonly [CborValue, CborValue]> }
  | { kind: "other" };

function readLength(
  bytes: Uint8Array,
  offset: number,
  info: number,
): { n: number; offset: number } | null {
  if (info < 24) return { n: info, offset };
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
  if (width === 0 || offset + width > bytes.length) return null;
  let n = 0;
  for (let i = 0; i < width; i++) n = n * 256 + (bytes[offset + i] ?? 0);
  return { n, offset: offset + width };
}

function readCbor(
  bytes: Uint8Array,
  offset: number,
): { value: CborValue; offset: number } | null {
  if (offset >= bytes.length) return null;
  const initial = bytes[offset] ?? 0;
  const major = initial >> 5;
  const info = initial & 0x1f;
  const length = readLength(bytes, offset + 1, info);
  if (!length) return null;
  if (major === 0) {
    return { value: { kind: "uint", n: length.n }, offset: length.offset };
  }
  if (major === 1) {
    return { value: { kind: "nint", n: -1 - length.n }, offset: length.offset };
  }
  if (major === 2 || major === 3) {
    const end = length.offset + length.n;
    if (end > bytes.length) return null;
    const slice = bytes.subarray(length.offset, end);
    if (major === 2) return { value: { kind: "bytes", b: slice }, offset: end };
    return {
      value: { kind: "text", s: new TextDecoder().decode(slice) },
      offset: end,
    };
  }
  if (major === 4) {
    const items: CborValue[] = [];
    let cursor = length.offset;
    for (let i = 0; i < length.n; i++) {
      const item = readCbor(bytes, cursor);
      if (!item) return null;
      items.push(item.value);
      cursor = item.offset;
    }
    return { value: { kind: "array", items }, offset: cursor };
  }
  if (major === 5) {
    const entries: Array<readonly [CborValue, CborValue]> = [];
    let cursor = length.offset;
    for (let i = 0; i < length.n; i++) {
      const key = readCbor(bytes, cursor);
      if (!key) return null;
      const value = readCbor(bytes, key.offset);
      if (!value) return null;
      entries.push([key.value, value.value]);
      cursor = value.offset;
    }
    return { value: { kind: "map", entries }, offset: cursor };
  }
  return { value: { kind: "other" }, offset: length.offset };
}

function mapBytes(value: CborValue, key: string): Uint8Array | null {
  if (value.kind !== "map") return null;
  for (const [entryKey, entryValue] of value.entries) {
    if (
      entryKey.kind === "text" &&
      entryKey.s === key &&
      entryValue.kind === "bytes"
    ) {
      return entryValue.b;
    }
  }
  return null;
}

function mapCoord(value: CborValue, key: number): Uint8Array | null {
  if (value.kind !== "map") return null;
  for (const [entryKey, entryValue] of value.entries) {
    const matches =
      (entryKey.kind === "nint" && entryKey.n === key) ||
      (entryKey.kind === "uint" && entryKey.n === key);
    if (matches && entryValue.kind === "bytes" && entryValue.b.length === 32) {
      return entryValue.b;
    }
  }
  return null;
}

/** COSE_Key EC2 P-256 (`kty` 2, `crv` 1) stored beside the credential id. */
export function encodeCoseP256(
  x: Uint8Array,
  y: Uint8Array,
): Uint8Array | null {
  if (x.length !== 32 || y.length !== 32) return null;
  const out = new Uint8Array(77);
  out.set([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20], 0);
  out.set(x, 10);
  out.set([0x22, 0x58, 0x20], 42);
  out.set(y, 45);
  return out;
}

export function coseP256ToSpki(cose: Uint8Array): Uint8Array | null {
  const parsed = readCbor(cose, 0);
  if (!parsed || parsed.offset !== cose.length) return null;
  const x = mapCoord(parsed.value, -2);
  const y = mapCoord(parsed.value, -3);
  if (!x || !y) return null;
  const spki = new Uint8Array(P256_SPKI_PREFIX.length + 65);
  spki.set(P256_SPKI_PREFIX, 0);
  spki[P256_SPKI_PREFIX.length] = 0x04;
  spki.set(x, P256_SPKI_PREFIX.length + 1);
  spki.set(y, P256_SPKI_PREFIX.length + 33);
  return spki;
}

function spkiToCose(spki: Uint8Array): Uint8Array | null {
  if (spki.length < 65 || spki[spki.length - 65] !== 0x04) return null;
  const point = spki.subarray(spki.length - 65);
  return encodeCoseP256(point.subarray(1, 33), point.subarray(33, 65));
}

function authDataFromAttestation(attestation: Uint8Array): Uint8Array | null {
  const parsed = readCbor(attestation, 0);
  if (!parsed) return null;
  const authData = mapBytes(parsed.value, "authData");
  return authData ? new Uint8Array(authData) : null;
}

function coseFromAuthData(authData: Uint8Array): Uint8Array | null {
  if (authData.length < 55 || (authData[32] & 0x40) === 0) return null;
  const credLen = ((authData[53] ?? 0) << 8) | (authData[54] ?? 0);
  const start = 55 + credLen;
  if (credLen === 0 || start >= authData.length) return null;
  return authData.subarray(start);
}

/** WebAuthn ES256 signatures are DER. The daemon verifier takes raw `r || s`. */
export function ecdsaDerToP1363(signature: Uint8Array): Uint8Array | null {
  if (signature.length === 64) return signature;
  if (signature[0] !== 0x30 || signature.length < 8) return null;
  let offset = 2;
  if ((signature[1] ?? 0) & 0x80) {
    offset = 2 + ((signature[1] ?? 0) & 0x7f);
  }
  const readInt = (): Uint8Array | null => {
    if (signature[offset] !== 0x02) return null;
    const len = signature[offset + 1] ?? 0;
    const start = offset + 2;
    const end = start + len;
    if (end > signature.length) return null;
    offset = end;
    return signature.subarray(start, end);
  };
  const r = readInt();
  const s = readInt();
  if (!r || !s) return null;
  const out = new Uint8Array(64);
  const put = (src: Uint8Array, at: number): boolean => {
    let value = src;
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32 || value.length === 0) return false;
    out.set(value, at + (32 - value.length));
    return true;
  };
  return put(r, 0) && put(s, 32) ? out : null;
}

function signCountOf(authData: Uint8Array): number | null {
  if (authData.length < 37) return null;
  return new DataView(
    authData.buffer,
    authData.byteOffset,
    authData.byteLength,
  ).getUint32(33);
}

function isCredential(value: Credential | null): value is PublicKeyCredential {
  if (!value || value.type !== "public-key") return false;
  const cred = value as PublicKeyCredential;
  return cred.rawId instanceof ArrayBuffer && typeof cred.response === "object";
}

function webauthnDomFailure(error: unknown): CliAppPasskeyFailure {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") {
      return failure(
        "webauthn_cancelled",
        "Passkey confirmation was cancelled.",
      );
    }
    if (
      error.name === "NotSupportedError" ||
      error.name === "SecurityError" ||
      error.name === "InvalidStateError"
    ) {
      return UNSUPPORTED;
    }
  }
  return failure("webauthn_failed", "The passkey step did not finish.");
}

function pageRpId(): string | null {
  const host = globalThis.location?.hostname;
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
    typeof response.getAuthenticatorData === "function"
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
        challenge,
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
  const material = publicKeyMaterial(
    created.response as AuthenticatorAttestationResponse,
  );
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
        challenge,
        timeout: 60_000,
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id: rawId }],
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
        challenge,
        timeout: 60_000,
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id: credentialId }],
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

export function cliAppWebAuthnRegisterPayload(
  vaultSessionRootDigest: string,
  registration: CliAppPasskeyRegistration,
): Readonly<{
  vaultSessionRootDigest: string;
  humanProof: string;
  credentialIdB64: string;
  publicKeySpkiB64: string;
  signCount: number;
}> {
  return {
    vaultSessionRootDigest,
    humanProof: registration.humanProof,
    credentialIdB64: registration.credentialIdB64,
    publicKeySpkiB64: registration.publicKeySpkiB64,
    signCount: registration.signCount,
  };
}
