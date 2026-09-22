/**
 * SOPS cloud master keys (B10, CLOUD-01/02/03/04).
 *
 * These are **not** OpenSesame root protectors. What a provider encrypts
 * here is the SOPS data key itself, or one 33-byte Shamir share — never a
 * root capsule, never an extra HKDF context, never an added AAD. The
 * encodings are upstream's, from `kms/keysource.go`, `azkv/keysource.go`
 * and `gcpkms/keysource.go` at 26e2f478:
 *
 *  - AWS KMS: `enc` is standard base64 of `CiphertextBlob`, the encryption
 *    context is carried verbatim, and the key identity is the full ARN.
 *  - Azure Key Vault: RSA-OAEP-256, and `enc` is **unpadded URL-safe**
 *    base64 of the operation result.
 *  - GCP KMS: `enc` is standard base64 of the ciphertext, and the key is
 *    named by its full resource id.
 *
 * Every locator in a document is untrusted: a request only ever goes to an
 * endpoint derived from a provider configuration the person approved, and
 * a returned key identity must match that configuration exactly.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { b64, unb64 } from "../aes-record.js";
import { assertSopsHttpsEndpoint, awsKeysMatch } from "../cloud-endpoint.js";
import { SopsError } from "../errors.js";
import { DATA_KEY_BYTES, SHARE_BYTES } from "../limits.js";
import type { ForeignMasterKey, SopsMasterKey } from "../metadata.js";
import type { MasterKeyProvider } from "./groups.js";

/** What a provider may wrap: the whole data key, or one group share. */
function assertPayload(payload: Uint8Array): void {
  if (
    payload.byteLength !== DATA_KEY_BYTES &&
    payload.byteLength !== SHARE_BYTES
  ) {
    throw new SopsError(
      "malformed_encoding",
      "A provider payload is neither a data key nor a share.",
    );
  }
}

function foreign(key: SopsMasterKey): ForeignMasterKey {
  if (key.kind === "age") {
    throw new SopsError(
      "provider_unavailable",
      "An age key is not a cloud master key.",
    );
  }
  return key;
}

/** Unpadded URL-safe base64, as Azure's SOPS path writes it. */
export function b64UrlRaw(bytes: Uint8Array): string {
  return b64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function unb64UrlRaw(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  return unb64(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
}

export type ProviderHttp = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** A provider's JSON body, parsed at the boundary and bounded in size. */
async function readJson(
  response: Response,
  limit = 64 * 1024,
): Promise<JsonObject> {
  const text = (await response.text()).slice(0, limit);
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isJsonObject(parsed)) {
    throw new SopsError(
      "provider_denied",
      "A provider returned a response this engine could not read.",
    );
  }
  return parsed;
}

function failed(response: Response): SopsError {
  if (response.status === 401 || response.status === 403) {
    return new SopsError(
      "provider_denied",
      `The provider refused the request (${response.status}).`,
    );
  }
  return new SopsError(
    "provider_unavailable",
    `The provider answered ${response.status}.`,
  );
}

async function send(
  http: ProviderHttp,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  assertSopsHttpsEndpoint(url);
  try {
    return await http(url, {
      ...init,
      signal,
      // A credential must never follow a redirect to another origin.
      redirect: "error",
      referrerPolicy: "no-referrer",
      credentials: "omit",
      mode: "cors",
    });
  } catch (caught) {
    if (caught instanceof SopsError) throw caught;
    // A browser cannot tell a blocked cross-origin read from a dead host.
    throw new SopsError(
      "provider_unavailable",
      "The provider could not be reached from this browser (network or CORS).",
    );
  }
}

/** AWS KMS carries the document's encryption context verbatim. */
export type EncryptionContext = Readonly<Record<string, string>>;
type MutableEncryptionContext = Record<string, string>;

export type AwsConfig = {
  /** The one ARN this adapter may use, from approved configuration. */
  keyArn: string;
  region: string;
  authorization: () => Promise<Record<string, string>>;
  http: ProviderHttp;
};

/** AWS KMS, upstream's `kms` record shape. */
/** The document's `context` map, carried verbatim into the request. */
function awsEncryptionContext(key: ForeignMasterKey): EncryptionContext {
  const found: MutableEncryptionContext = {};
  for (const item of key.raw.items) {
    if (
      item.kind !== "entry" ||
      item.key !== "context" ||
      item.value.kind !== "map"
    ) {
      continue;
    }
    for (const pair of item.value.items) {
      if (
        pair.kind === "entry" &&
        pair.value.kind === "scalar" &&
        pair.value.scalar.kind === "str"
      ) {
        found[pair.key] = pair.value.scalar.value;
      }
    }
  }
  return found;
}

export function awsKmsProvider(config: AwsConfig): MasterKeyProvider {
  const endpoint = `https://kms.${config.region}.amazonaws.com/`;
  const call = async (
    target: string,
    body: JsonObject,
    signal: AbortSignal,
  ) => {
    const response = await send(
      config.http,
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": target,
          ...(await config.authorization()),
        },
        body: JSON.stringify(body),
      },
      signal,
    );
    if (!response.ok) throw failed(response);
    return readJson(response);
  };
  return {
    kind: "kms",
    async unwrap(key, signal) {
      const record = foreign(key);
      // The document's ARN is untrusted: only the approved key is used.
      if (!awsKeysMatch(config.keyArn, record.locator)) return null;
      const json = await call(
        "TrentService.Decrypt",
        {
          KeyId: config.keyArn,
          CiphertextBlob: record.enc,
          EncryptionContext: awsEncryptionContext(record),
        },
        signal,
      );
      const returned = isString(json.KeyId) ? json.KeyId : "";
      if (!awsKeysMatch(config.keyArn, returned)) {
        throw new SopsError(
          "provider_denied",
          "AWS KMS answered for a different key.",
        );
      }
      const plaintext = isString(json.Plaintext)
        ? unb64(json.Plaintext)
        : new Uint8Array();
      assertPayload(plaintext);
      return plaintext;
    },
    async wrap(key, payload, signal) {
      assertPayload(payload);
      const record = foreign(key);
      const json = await call(
        "TrentService.Encrypt",
        {
          KeyId: config.keyArn,
          Plaintext: b64(payload),
          EncryptionContext: awsEncryptionContext(record),
        },
        signal,
      );
      const returned = isString(json.KeyId) ? json.KeyId : "";
      if (!awsKeysMatch(config.keyArn, returned)) {
        throw new SopsError(
          "provider_denied",
          "AWS KMS answered for a different key.",
        );
      }
      const blob = isString(json.CiphertextBlob) ? json.CiphertextBlob : "";
      if (blob === "")
        throw new SopsError(
          "provider_denied",
          "AWS KMS returned no ciphertext.",
        );
      return { ...record, enc: blob };
    },
  };
}

export type AzureConfig = {
  vaultUrl: string;
  name: string;
  /** Concrete version; a blank version is refused, never guessed. */
  version: string;
  authorization: () => Promise<Record<string, string>>;
  http: ProviderHttp;
};

/** Azure Key Vault, upstream's RSA-OAEP-256 path. */
export function azureKeyVaultProvider(config: AzureConfig): MasterKeyProvider {
  if (config.version.trim() === "") {
    throw new SopsError(
      "unauthorized_policy",
      "An Azure key version must be explicit.",
    );
  }
  const identity = `${config.vaultUrl.replace(/\/+$/u, "")}/keys/${config.name}/${config.version}`;
  const call = async (
    operation: "encrypt" | "decrypt",
    value: string,
    signal: AbortSignal,
  ) => {
    const url = `${identity}/${operation}?api-version=7.4`;
    const response = await send(
      config.http,
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await config.authorization()),
        },
        body: JSON.stringify({ alg: "RSA-OAEP-256", value }),
      },
      signal,
    );
    if (!response.ok) throw failed(response);
    return readJson(response);
  };
  return {
    kind: "azure_kv",
    async unwrap(key, signal) {
      const record = foreign(key);
      if (
        record.locator.replace(/\/+$/u, "") !==
        config.vaultUrl.replace(/\/+$/u, "")
      )
        return null;
      const json = await call("decrypt", record.enc, signal);
      const value = isString(json.value)
        ? unb64UrlRaw(json.value)
        : new Uint8Array();
      assertPayload(value);
      return value;
    },
    async wrap(key, payload, signal) {
      assertPayload(payload);
      const record = foreign(key);
      const json = await call("encrypt", b64UrlRaw(payload), signal);
      const value = isString(json.value) ? json.value : "";
      if (value === "")
        throw new SopsError(
          "provider_denied",
          "Azure Key Vault returned no ciphertext.",
        );
      return { ...record, enc: value };
    },
  };
}

export type GcpConfig = {
  /** `projects/…/locations/…/keyRings/…/cryptoKeys/…` */
  resourceId: string;
  authorization: () => Promise<Record<string, string>>;
  http: ProviderHttp;
};

/** GCP KMS, upstream's base64 ciphertext and resource naming. */
export function gcpKmsProvider(config: GcpConfig): MasterKeyProvider {
  const call = async (
    operation: "encrypt" | "decrypt",
    body: JsonObject,
    signal: AbortSignal,
  ) => {
    const url = `https://cloudkms.googleapis.com/v1/${config.resourceId}:${operation}`;
    const response = await send(
      config.http,
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await config.authorization()),
        },
        body: JSON.stringify(body),
      },
      signal,
    );
    if (!response.ok) throw failed(response);
    return readJson(response);
  };
  return {
    kind: "gcp_kms",
    async unwrap(key, signal) {
      const record = foreign(key);
      if (record.locator !== config.resourceId) return null;
      const json = await call("decrypt", { ciphertext: record.enc }, signal);
      const plaintext = isString(json.plaintext)
        ? unb64(json.plaintext)
        : new Uint8Array();
      assertPayload(plaintext);
      return plaintext;
    },
    async wrap(key, payload, signal) {
      assertPayload(payload);
      const record = foreign(key);
      const json = await call("encrypt", { plaintext: b64(payload) }, signal);
      const ciphertext = isString(json.ciphertext) ? json.ciphertext : "";
      if (ciphertext === "")
        throw new SopsError(
          "provider_denied",
          "GCP KMS returned no ciphertext.",
        );
      return { ...record, enc: ciphertext };
    },
  };
}
