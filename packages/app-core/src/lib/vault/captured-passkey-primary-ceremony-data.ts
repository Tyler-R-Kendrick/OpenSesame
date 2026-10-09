/** Original Host WebAuthn/PRF data only. No owner, lease or REAL admission. */
import {
  type PasskeyUnlockRecord,
  b64ToBytes,
  bytesToB64,
  randomBytes,
} from "@opensesame/vault-core";
import { z } from "zod";
import { host } from "../../host.js";
import { assertUnambiguousJson } from "../retired-credentials/json-preflight.js";

const actualHost = host;
const actualDigest = crypto.subtle.digest.bind(crypto.subtle);
const actualRandom = randomBytes;
const actualEncode = bytesToB64;
const actualDecode = b64ToBytes;
type PrimaryPrfEvaluation = Record<string, AuthenticationExtensionsPRFValues>;
const clientData = z.object({
  type: z.literal("webauthn.get"),
  challenge: z.string().min(1).max(256),
  origin: z.string().min(1).max(4096),
  crossOrigin: z.literal(false).optional(),
  topOrigin: z.never().optional(),
});
function unavailable(): never {
  throw new Error("Original passkey authentication is unavailable.");
}
function urlEncoded(bytes: Uint8Array): string {
  return actualEncode(bytes)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}
function exactBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
function assertPrimaryOrigin(origin: string, rpId: string) {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.hostname !== rpId ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && rpId === "localhost")) ||
    rpId.includes(":") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(rpId)
  )
    unavailable();
}
class OriginalPrimaryHost {
  readonly owner = actualHost();
  readonly page = this.owner.page;
  readonly authenticator = this.owner.authenticator;
  readonly credentials = this.authenticator?.credentials;
  readonly api = this.authenticator?.publicKeyCredential;
  readonly get = this.credentials?.get;
  readonly location = this.page?.location;
  readonly origin = this.location?.origin;
  readonly rpId = this.location?.hostname;
  capture(original: () => void, signal?: AbortSignal) {
    const {
      owner,
      page,
      authenticator,
      credentials,
      api,
      get,
      location,
      origin,
      rpId,
    } = this;
    if (
      !page ||
      !location ||
      !authenticator ||
      !page.isSecureContext ||
      !credentials ||
      !get ||
      !api ||
      !origin ||
      !rpId
    )
      unavailable();
    assertPrimaryOrigin(origin, rpId);
    const check = () => {
      original();
      if (signal?.aborted)
        throw new DOMException("The operation was aborted.", "AbortError");
      if (
        actualHost() !== owner ||
        owner.page !== page ||
        page.location !== location ||
        !page.isSecureContext ||
        location.origin !== origin ||
        location.hostname !== rpId ||
        owner.authenticator !== authenticator ||
        authenticator.credentials !== credentials ||
        credentials.get !== get ||
        authenticator.publicKeyCredential !== api
      )
        unavailable();
    };
    return { credentials, get, api, origin, rpId, check };
  }
}
function captureOriginalPrimaryHost(
  original: () => void,
  signal?: AbortSignal,
) {
  return new OriginalPrimaryHost().capture(original, signal);
}

function assertAllowedPrimaryRecords(allowed: readonly PasskeyUnlockRecord[]) {
  if (
    allowed.length < 1 ||
    allowed.length > 32 ||
    new Set(allowed.map((record) => record.credentialIdB64)).size !==
      allowed.length
  )
    unavailable();
}
class DeliveredPrimaryPrf {
  #platform: ArrayBuffer | undefined;
  capture(credential: Credential | null, api: typeof PublicKeyCredential) {
    if (!(credential instanceof api) || credential.type !== "public-key")
      unavailable();
    // Retain delivered original buffers before cancellation; not assertion admission.
    const result = credential.getClientExtensionResults();
    const candidate = result.prf?.results?.first;
    if (candidate instanceof ArrayBuffer) this.#platform = candidate;
    return credential;
  }
  read() {
    if (!this.#platform || this.#platform.byteLength !== 32) unavailable();
    return this.#platform;
  }
  close() {
    if (this.#platform) new Uint8Array(this.#platform).fill(0);
  }
}
function selectedPrimaryRecord(
  credential: PublicKeyCredential,
  allowed: readonly PasskeyUnlockRecord[],
) {
  const id = new Uint8Array(credential.rawId).slice();
  const selected = allowed.filter(
    (record) => record.credentialIdB64 === actualEncode(id),
  );
  if (selected.length !== 1 || !selected[0]) unavailable();
  return { id, record: selected[0] };
}
function primaryResponseBytes(response: AuthenticatorResponse) {
  if (
    !(response.clientDataJSON instanceof ArrayBuffer) ||
    !("authenticatorData" in response) ||
    !(response.authenticatorData instanceof ArrayBuffer)
  )
    unavailable();
  const clientBytes = new Uint8Array(response.clientDataJSON).slice();
  const authBytes = new Uint8Array(response.authenticatorData).slice();
  if (
    clientBytes.length > 8192 ||
    authBytes.length < 37 ||
    authBytes.length > 16384
  )
    unavailable();
  return { clientBytes, authBytes };
}
function assertPrimaryClient(
  clientBytes: Uint8Array,
  origin: string,
  challenge: Uint8Array,
) {
  const clientText = new TextDecoder("utf-8", { fatal: true }).decode(
    clientBytes,
  );
  assertUnambiguousJson(clientText, 8192);
  const client = clientData.parse(JSON.parse(clientText));
  if (client.origin !== origin || client.challenge !== urlEncoded(challenge))
    unavailable();
}
function assertPrimaryFlags(authBytes: Uint8Array) {
  const flags = authBytes[32];
  if (
    flags === undefined ||
    (flags & 0x05) !== 0x05 ||
    (flags & 0x40) !== 0 ||
    ((flags & 0x10) !== 0 && (flags & 0x08) === 0)
  )
    unavailable();
}
function primaryDescriptors(allowed: readonly PasskeyUnlockRecord[]) {
  const evalByCredential: PrimaryPrfEvaluation = {};
  const descriptors = allowed.map((record) => {
    const id = actualDecode(record.credentialIdB64);
    const salt = actualDecode(record.prfSaltB64);
    if (
      !id.length ||
      id.length > 1024 ||
      actualEncode(id) !== record.credentialIdB64 ||
      salt.length !== 32 ||
      actualEncode(salt) !== record.prfSaltB64
    )
      unavailable();
    evalByCredential[urlEncoded(id)] = { first: Uint8Array.from(salt).buffer };
    const buffer = Uint8Array.from(id).buffer;
    return { type: "public-key" as const, id: buffer };
  });
  return { evalByCredential, descriptors };
}
/**
 * Await the actual credential request to settle, including cancellation, before returning.
 * Browser Host credentials are trusted platform IO; this is not independent signature
 * verification (existing PRF wraps retain no credential public key). Root/MAC proof follows.
 */
export async function capturePasskeyPrimaryCeremonyData(
  records: readonly PasskeyUnlockRecord[],
  original: () => void,
  signal?: AbortSignal,
) {
  const allowed = structuredClone(records);
  const { credentials, get, api, origin, rpId, check } =
    captureOriginalPrimaryHost(original, signal);
  assertAllowedPrimaryRecords(allowed);
  check();
  const challenge = actualRandom(32);
  const { evalByCredential, descriptors } = primaryDescriptors(allowed);
  const delivered = new DeliveredPrimaryPrf();
  try {
    const options: CredentialRequestOptions = {
      publicKey: {
        challenge: Uint8Array.from(challenge).buffer,
        rpId,
        allowCredentials: descriptors,
        userVerification: "required",
        timeout: 120000,
        extensions: { prf: { evalByCredential } },
      },
    };
    if (signal) options.signal = signal;
    const received = await get.call(credentials, options);
    const credential = delivered.capture(received, api);
    check();
    const platformPrf = delivered.read();
    const selected = selectedPrimaryRecord(credential, allowed);
    const { clientBytes, authBytes } = primaryResponseBytes(
      credential.response,
    );
    assertPrimaryClient(clientBytes, origin, challenge);
    assertPrimaryFlags(authBytes);
    const rpHash = new Uint8Array(
      await actualDigest(
        "SHA-256",
        Uint8Array.from(new TextEncoder().encode(rpId)).buffer,
      ),
    );
    check();
    if (!exactBytes(authBytes.subarray(0, 32), rpHash)) unavailable();
    check();
    return Object.freeze({
      record: selected.record,
      prfOutput: platformPrf.slice(0),
      credentialIdB64: actualEncode(selected.id),
    });
  } finally {
    delivered.close();
    challenge.fill(0);
  }
}
