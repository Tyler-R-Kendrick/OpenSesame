/**
 * A virtual roaming authenticator that makes real WebAuthn artifacts: SPKI
 * public keys, authenticator data with flags and a counter, DER ECDSA
 * signatures (high-S and leading-zero integers included) and the PRF
 * extension computed the way the specification defines it:
 *
 *   output = HMAC-SHA-256(CredRandom, SHA-256("WebAuthn PRF" || 0x00 || input))
 *
 * Test support only. Each instance is one physical key.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { overlapCast } from "@opensesame/os-domain";
import { concat, randomBytes, toB64url, utf8Bytes } from "./bytes.js";
import type { Container } from "./ceremony.js";

const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

type Stored = {
  id: Uint8Array;
  rpId: string;
  alg: -7 | -8;
  credRandom: Uint8Array;
  es256?: CryptoKeyPair;
  ed25519?: Uint8Array;
  publicKeySpki: Uint8Array;
  counter: number;
};

export type VirtualOptions = {
  origin: string;
  alg?: -7 | -8;
  /** Report user verification (a PIN or biometric) in the flags. */
  userVerified?: boolean;
  /** Counter behaviour: a roaming key counts up, a synced passkey stays 0. */
  counter?: "increment" | "zero";
  /** Does the key do hmac-secret at all. */
  prf?: boolean;
  /** `hmac-secret-mc`: return PRF output from create() as well. */
  prfAtCreate?: boolean;
  /** Hash this RP ID into authenticator data instead of the real one. */
  authDataRpId?: string;
  /** Replace the flags byte outright (e.g. 0x04 for UV without presence). */
  forceFlags?: number;
};

function bufferOf(source: BufferSource): Uint8Array {
  return source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

function derInt(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  let int = value.slice(start);
  if ((int[0] ?? 0) & 0x80) int = concat(Uint8Array.of(0), int);
  return concat(Uint8Array.of(0x02, int.length), int);
}

/** r || s -> ASN.1 DER. */
export function p1363ToDer(raw: Uint8Array): Uint8Array {
  const body = concat(derInt(raw.slice(0, 32)), derInt(raw.slice(32, 64)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

export function prfOutput(
  credRandom: Uint8Array,
  input: Uint8Array,
): Uint8Array {
  const salt = sha256(
    concat(utf8Bytes("WebAuthn PRF"), Uint8Array.of(0), input),
  );
  return hmac(sha256, credRandom, salt);
}

export class VirtualAuthenticator {
  private readonly credentials_: Stored[] = [];
  /** Set to make the next PRF evaluations unstable, as a broken key would. */
  unstablePrf = false;

  constructor(private readonly options: VirtualOptions) {}

  readonly credentials = {
    create: (request: CredentialCreationOptions) => this.create(request),
    get: (request: CredentialRequestOptions) => this.get(request),
  };

  setOrigin(origin: string): void {
    this.options.origin = origin;
  }

  setUserVerified(verified: boolean): void {
    this.options.userVerified = verified;
  }

  set(options: Partial<VirtualOptions>): void {
    Object.assign(this.options, options);
  }

  private authenticatorData(rpId: string, counter: number): Uint8Array {
    const uv = this.options.userVerified ?? true;
    const flags = this.options.forceFlags ?? 0x01 | (uv ? 0x04 : 0);
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, counter, false);
    return concat(
      sha256(utf8Bytes(this.options.authDataRpId ?? rpId)),
      Uint8Array.of(flags),
      count,
    );
  }

  private clientData(type: string, challenge: BufferSource): Uint8Array {
    return utf8Bytes(
      JSON.stringify({
        type,
        challenge: toB64url(bufferOf(challenge)),
        origin: this.options.origin,
        crossOrigin: false,
      }),
    );
  }

  private async create(request: CredentialCreationOptions) {
    const pk = request.publicKey;
    if (!pk) throw new DOMException("no publicKey", "NotSupportedError");
    const alg = this.options.alg ?? -7;
    const stored: Stored = {
      id: randomBytes(32),
      rpId: pk.rp.id ?? new URL(this.options.origin).hostname,
      alg,
      credRandom: randomBytes(32),
      publicKeySpki: new Uint8Array(0),
      counter: 0,
    };
    if (alg === -7) {
      stored.es256 = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      stored.publicKeySpki = new Uint8Array(
        await crypto.subtle.exportKey("spki", stored.es256.publicKey),
      );
    } else {
      stored.ed25519 = ed25519.utils.randomSecretKey();
      stored.publicKeySpki = concat(
        ED25519_SPKI_PREFIX,
        ed25519.getPublicKey(stored.ed25519),
      );
    }
    this.credentials_.push(stored);
    const results: AuthenticationExtensionsClientOutputs = {};
    if (pk.extensions?.prf && (this.options.prf ?? true)) {
      const first = pk.extensions.prf.eval?.first;
      results.prf =
        this.options.prfAtCreate && first
          ? {
              enabled: true,
              results: { first: this.evaluate(stored, bufferOf(first)).buffer },
            }
          : { enabled: true };
    }
    return {
      type: "public-key",
      id: toB64url(stored.id),
      rawId: stored.id.buffer.slice(0),
      response: {
        clientDataJSON: this.clientData("webauthn.create", pk.challenge).buffer,
        getPublicKey: () => stored.publicKeySpki.buffer.slice(0),
        getPublicKeyAlgorithm: () => alg,
      },
      getClientExtensionResults: () => results,
    };
  }

  private evaluate(stored: Stored, input: Uint8Array): Uint8Array {
    const out = prfOutput(stored.credRandom, input);
    if (this.unstablePrf)
      out[0] = (out[0] ?? 0) ^ ((randomBytes(1)[0] ?? 0) | 1);
    return out;
  }

  private async sign(stored: Stored, message: Uint8Array): Promise<Uint8Array> {
    if (stored.alg === -8 && stored.ed25519) {
      return ed25519.sign(message, stored.ed25519);
    }
    if (!stored.es256) throw new Error("no key");
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        stored.es256.privateKey,
        message,
      ),
    );
    return p1363ToDer(raw);
  }

  private async get(request: CredentialRequestOptions) {
    const pk = request.publicKey;
    if (!pk) throw new DOMException("no publicKey", "NotSupportedError");
    const rpId = pk.rpId ?? new URL(this.options.origin).hostname;
    const wanted = (pk.allowCredentials ?? []).map((c) =>
      toB64url(bufferOf(c.id)),
    );
    const stored = this.credentials_.find(
      (c) =>
        c.rpId === rpId &&
        (wanted.length === 0 || wanted.includes(toB64url(c.id))),
    );
    if (!stored) throw new DOMException("no credential", "NotAllowedError");
    stored.counter +=
      (this.options.counter ?? "increment") === "increment" ? 1 : 0;
    const authData = this.authenticatorData(rpId, stored.counter);
    const clientData = this.clientData("webauthn.get", pk.challenge);
    const signature = await this.sign(
      stored,
      concat(authData, sha256(clientData)),
    );
    const results: AuthenticationExtensionsClientOutputs = {};
    const first = pk.extensions?.prf?.eval?.first;
    if (first && (this.options.prf ?? true)) {
      results.prf = {
        enabled: true,
        results: { first: this.evaluate(stored, bufferOf(first)).buffer },
      };
    }
    return {
      type: "public-key",
      id: toB64url(stored.id),
      rawId: stored.id.buffer.slice(0),
      response: {
        clientDataJSON: clientData.buffer,
        authenticatorData: authData.buffer,
        signature: signature.buffer,
        userHandle: null,
      },
      getClientExtensionResults: () => results,
    };
  }
}

/** What a double offers in place of the DOM's credentials container. */
export type ContainerDouble = Readonly<{
  create(request: CredentialCreationOptions): Promise<object>;
  get(request: CredentialRequestOptions): Promise<object>;
}>;

/**
 * The one place a test double is declared to be the DOM container. The
 * double's results carry the fields the ceremony reads and no more.
 */
export function asContainer(double: ContainerDouble): Container {
  const container: Container = overlapCast(double);
  return container;
}
