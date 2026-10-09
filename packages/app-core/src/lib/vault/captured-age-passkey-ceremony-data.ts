/** Captured original Host PRF DATA for the pinned age FIDO2 protocol; not primary, factor or REAL admission. */
import { bytesToB64, randomBytes } from "@opensesame/vault-core";
import { z } from "zod";
import { host } from "../../host.js";
import { assertUnambiguousJson } from "../retired-credentials/json-preflight.js";
import { ProtectionError } from "./protection/errors.js";
const actualHost = host;
const actualDigest = crypto.subtle.digest.bind(crypto.subtle);
const actualRandom = randomBytes;
const LABEL = new TextEncoder().encode("age-encryption.org/fido2prf");
const clientData = z.object({
  type: z.literal("webauthn.get"),
  challenge: z.string().min(1).max(256),
  origin: z.string().min(1).max(4096),
  crossOrigin: z.literal(false).optional(),
  topOrigin: z.never().optional(),
});
function unavailable(): never {
  throw new ProtectionError(
    "enrollment_proof_failed",
    "Original age-passkey assertion is unavailable.",
  );
}
function urlEncoded(bytes: Uint8Array): string {
  return bytesToB64(bytes)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}
function exact(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
function assertAgeOrigin(origin: string, hostname: string) {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.hostname !== hostname ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && hostname === "localhost"))
  )
    unavailable();
}
class OriginalAgeHost {
  readonly owner = actualHost();
  readonly page = this.owner.page;
  readonly authenticator = this.owner.authenticator;
  readonly location = this.page?.location;
  readonly credentials = this.authenticator?.credentials;
  readonly get = this.credentials?.get;
  readonly api = this.authenticator?.publicKeyCredential;
  readonly origin = this.location?.origin;
  readonly hostname = this.location?.hostname;
  capture(original: () => void, signal?: AbortSignal) {
    const {
      owner,
      page,
      authenticator,
      location,
      credentials,
      get,
      api,
      origin,
      hostname,
    } = this;
    if (
      !page ||
      !page.isSecureContext ||
      !authenticator ||
      !location ||
      !credentials ||
      !get ||
      !api ||
      !origin ||
      !hostname
    )
      throw new ProtectionError(
        "unsupported_runtime",
        "An original secure Host authenticator is required.",
      );
    assertAgeOrigin(origin, hostname);
    const check = () => {
      original();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (
        actualHost() !== owner ||
        owner.page !== page ||
        page.location !== location ||
        !page.isSecureContext ||
        location.origin !== origin ||
        location.hostname !== hostname ||
        owner.authenticator !== authenticator ||
        authenticator.credentials !== credentials ||
        credentials.get !== get ||
        authenticator.publicKeyCredential !== api
      )
        throw new ProtectionError(
          "stale_operation",
          "Original age-passkey Host changed.",
        );
    };
    return { credentials, get, api, origin, hostname, check };
  }
}
function captureOriginalAgeHost(original: () => void, signal?: AbortSignal) {
  return new OriginalAgeHost().capture(original, signal);
}

function assertAgeRequest(
  requests: number,
  id: Uint8Array,
  nonce: Uint8Array,
  rpId: string,
  hostname: string,
) {
  if (
    requests > 8 ||
    id.length < 1 ||
    id.length > 1024 ||
    nonce.length !== 16 ||
    rpId.length > 253 ||
    !rpId ||
    rpId !== rpId.toLowerCase() ||
    rpId.includes(":") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(rpId) ||
    (hostname !== rpId && !hostname.endsWith(`.${rpId}`))
  )
    unavailable();
}
class DeliveredAgePrf {
  readonly first: Uint8Array;
  readonly second: Uint8Array;
  readonly challenge: Uint8Array;
  #platformFirst: ArrayBuffer | undefined;
  #platformSecond: ArrayBuffer | undefined;
  constructor(nonce: Uint8Array) {
    const first = new Uint8Array(LABEL.length + 1 + nonce.length);
    first.set(LABEL);
    first[LABEL.length] = 1;
    first.set(nonce, LABEL.length + 1);
    const second = first.slice();
    second[LABEL.length] = 2;
    const challenge = actualRandom(32);
    this.first = first;
    this.second = second;
    this.challenge = challenge;
  }
  capture(credential: Credential | null, api: typeof PublicKeyCredential) {
    if (!(credential instanceof api) || credential.type !== "public-key")
      unavailable();
    // Retain delivered original buffers before cancellation; not assertion admission.
    const extensions = credential.getClientExtensionResults();
    const firstResult = extensions.prf?.results?.first;
    const secondResult = extensions.prf?.results?.second;
    if (firstResult instanceof ArrayBuffer) this.#platformFirst = firstResult;
    if (secondResult instanceof ArrayBuffer)
      this.#platformSecond = secondResult;
    return credential;
  }
  read() {
    if (
      !this.#platformFirst ||
      this.#platformFirst.byteLength !== 32 ||
      !this.#platformSecond ||
      this.#platformSecond.byteLength !== 32
    )
      unavailable();
    return { first: this.#platformFirst, second: this.#platformSecond };
  }
  close() {
    if (this.#platformFirst) new Uint8Array(this.#platformFirst).fill(0);
    if (this.#platformSecond) new Uint8Array(this.#platformSecond).fill(0);
    this.first.fill(0);
    this.second.fill(0);
    this.challenge.fill(0);
  }
}
function assertAgeCredential(
  credential: PublicKeyCredential,
  api: typeof PublicKeyCredential,
  id: Uint8Array,
) {
  if (
    !(credential instanceof api) ||
    credential.type !== "public-key" ||
    !(credential.rawId instanceof ArrayBuffer) ||
    !exact(new Uint8Array(credential.rawId), id)
  )
    unavailable();
}
function ageResponseBytes(response: AuthenticatorResponse) {
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
function assertAgeClient(
  clientBytes: Uint8Array,
  origin: string,
  challenge: Uint8Array,
) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(clientBytes);
  assertUnambiguousJson(text, 8192);
  const client = clientData.parse(JSON.parse(text));
  if (client.origin !== origin || client.challenge !== urlEncoded(challenge))
    unavailable();
}
function assertAgeFlags(authBytes: Uint8Array) {
  const flags = authBytes[32];
  if (
    flags === undefined ||
    (flags & 0x05) !== 0x05 ||
    (flags & 0x40) !== 0 ||
    ((flags & 0x10) !== 0 && (flags & 0x08) === 0)
  )
    unavailable();
}
class OriginalAgeRequests {
  #requests = 0;
  readonly #frame: ReturnType<typeof captureOriginalAgeHost>;
  readonly #signal: AbortSignal | undefined;
  constructor(
    frame: ReturnType<typeof captureOriginalAgeHost>,
    signal?: AbortSignal,
  ) {
    this.#frame = frame;
    this.#signal = signal;
  }
  async request(
    credentialId: Uint8Array,
    rpId: string,
    transports: readonly AuthenticatorTransport[],
    stanzaNonce: Uint8Array,
  ) {
    const { credentials, get, api, origin, hostname, check } = this.#frame;
    const signal = this.#signal;
    check();
    const id = credentialId.slice();
    const nonce = stanzaNonce.slice();
    const hints = [...transports];
    assertAgeRequest(++this.#requests, id, nonce, rpId, hostname);
    const delivered = new DeliveredAgePrf(nonce);
    const { first, second, challenge } = delivered;
    try {
      const options: CredentialRequestOptions = {
        publicKey: {
          allowCredentials: [
            {
              type: "public-key",
              id: Uint8Array.from(id).buffer,
              transports: hints,
            },
          ],
          rpId,
          challenge: Uint8Array.from(challenge).buffer,
          userVerification: "required",
          timeout: 120000,
          extensions: {
            prf: {
              eval: {
                first: Uint8Array.from(first).buffer,
                second: Uint8Array.from(second).buffer,
              },
            },
          },
        },
      };
      if (signal) options.signal = signal;
      const received = await get.call(credentials, options);
      const credential = delivered.capture(received, api);
      check();
      const output = delivered.read();
      assertAgeCredential(credential, api, id);
      const { clientBytes, authBytes } = ageResponseBytes(credential.response);
      assertAgeClient(clientBytes, origin, challenge);
      assertAgeFlags(authBytes);
      const hash = new Uint8Array(
        await actualDigest(
          "SHA-256",
          Uint8Array.from(new TextEncoder().encode(rpId)).buffer,
        ),
      );
      check();
      if (!exact(authBytes.subarray(0, 32), hash)) unavailable();
      return Object.freeze({
        first: output.first.slice(0),
        second: output.second.slice(0),
      });
    } finally {
      delivered.close();
      nonce.fill(0);
      id.fill(0);
    }
  }
}
/** Capture before loading age or starting any asynchronous crypto. Await actual get settlement even after cancellation. */
export function captureAgePasskeyCeremonyData(
  original: () => void,
  signal?: AbortSignal,
) {
  const frame = captureOriginalAgeHost(original, signal);
  frame.check();
  const requests = new OriginalAgeRequests(frame, signal);
  return requests.request.bind(requests);
}
