/**
 * The pepper seal ADR 0173 writes (`PepperSealV2`): a secret held under a
 * pepper through OPAQUE, RFC 9807 (ristretto255, Argon2id), as implemented by
 * `@serenity-kit/opaque` (the Rust `opaque-ke` crate in WebAssembly). Nothing
 * here is protocol code of our own.
 *
 * The pepper is the OPAQUE password. Registration produces the record a server
 * would keep and an export key only the client can recompute; the export key
 * becomes the AES-GCM key that holds the secret. Opening runs the login: a
 * wrong pepper fails it, before anything is decrypted, instead of producing a
 * wrong-looking secret. The "server" half (`serverSetup`, `registrationRecord`)
 * lives beside the seal in the vault body, so what OPAQUE adds here is the
 * standard's memory-hard key stretching and its wrong-pepper detection, not a
 * second holder (ADR 0173 says so).
 *
 * The library carries its WebAssembly inline, so it loads on first use.
 */

import {
  type PepperSealV2,
  VaultCorruptError,
  WrongPepperError,
  b64ToBytes,
  bytesToB64,
} from "@opensesame/vault-core";

type OpaqueLibrary = typeof import("@serenity-kit/opaque");
type KeyStretching = NonNullable<
  Parameters<OpaqueLibrary["client"]["finishRegistration"]>[0]["keyStretching"]
>;

/**
 * Argon2id at 64 MiB, three passes, one lane: RFC 9106's second recommended
 * option with the lanes folded to one for a single-threaded engine, about a
 * quarter of a second here. RFC 9807's own recommendation (2 GiB) does not fit
 * a browser tab. `fast` is for tests and is never what the app writes.
 */
const KSF = {
  standard: {
    "argon2id-custom": { iterations: 3, memory: 65536, parallelism: 1 },
  },
  fast: { "argon2id-custom": { iterations: 1, memory: 8, parallelism: 1 } },
} as const satisfies Record<PepperSealV2["ksf"], KeyStretching>;

let writing: PepperSealV2["ksf"] = "standard";

/** Tests ask for the cheap cost; the app never does. */
export function writeSealsWith(ksf: PepperSealV2["ksf"]): void {
  writing = ksf;
}

let loading: Promise<OpaqueLibrary> | undefined;

async function loadOpaque(): Promise<OpaqueLibrary> {
  if (!loading) {
    loading = import("@serenity-kit/opaque").then(async (library) => {
      await library.ready;
      return library;
    });
  }
  return loading;
}

const enc = new TextEncoder();
const SALT = enc.encode("opensesame/pepper-seal/v2");
const IV_BYTES = 12;

/** The AES-GCM key an export key becomes, bound to the method it protects. */
async function sealKey(exportKey: string, binding: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(exportKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: enc.encode(binding) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function aad(binding: string): AesGcmParams["additionalData"] {
  return enc.encode(binding);
}

export async function sealWithOpaque(
  secret: string,
  pepper: string,
  binding: string,
): Promise<PepperSealV2> {
  if (pepper === "") throw new Error("A pepper cannot be empty.");
  const opaque = await loadOpaque();
  const ksf = writing;
  const password = pepper.normalize("NFKC");
  const serverSetup = opaque.server.createSetup();
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password });
  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup,
    userIdentifier: binding,
    registrationRequest,
  });
  const { registrationRecord, exportKey } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password,
    keyStretching: KSF[ksf],
  });
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(binding) },
    await sealKey(exportKey, binding),
    enc.encode(secret),
  );
  return {
    v: 2,
    suite: "rfc9807-ristretto255-argon2id",
    ksf,
    serverSetup,
    registrationRecord,
    seal: { ivB64: bytesToB64(iv), ctB64: bytesToB64(new Uint8Array(body)) },
  };
}

/**
 * The OPAQUE login for one seal: the export key, `undefined` for a wrong pepper
 * (or another method's seal), and `VaultCorruptError` for a record the library
 * cannot read at all.
 */
function loginResult(
  opaque: OpaqueLibrary,
  sealed: PepperSealV2,
  password: string,
  binding: string,
): { exportKey: string } | undefined {
  try {
    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
      password,
    });
    const { loginResponse } = opaque.server.startLogin({
      userIdentifier: binding,
      registrationRecord: sealed.registrationRecord,
      serverSetup: sealed.serverSetup,
      startLoginRequest,
    });
    return opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password,
      keyStretching: KSF[sealed.ksf],
    });
  } catch {
    throw new VaultCorruptError("The pepper seal could not be read.");
  }
}

/** Throws `WrongPepperError` for a wrong pepper or a seal moved to another method. */
export async function openWithOpaque(
  sealed: PepperSealV2,
  pepper: string,
  binding: string,
): Promise<string> {
  if (pepper === "") throw new WrongPepperError();
  const opaque = await loadOpaque();
  const password = pepper.normalize("NFKC");
  const result = loginResult(opaque, sealed, password, binding);
  if (!result) throw new WrongPepperError();
  try {
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: b64ToBytes(sealed.seal.ivB64),
        additionalData: aad(binding),
      },
      await sealKey(result.exportKey, binding),
      b64ToBytes(sealed.seal.ctB64),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    // Opened the OPAQUE record but not the secret: the seal was moved.
    throw new WrongPepperError();
  }
}
