import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Secret drop acceptance (ADR 0062) — the recipient side.
 *
 * A drop link is `/claim#token=osc_clm_…&key=…`: the claim bearer and the
 * drop key both ride the fragment, so neither reaches a server log. The
 * recipient enters the user code (the out-of-band second factor), the page
 * presents `{token, userCode}` — the code is verified server-side before the
 * single-use CAS — and the present response, the only projection that carries
 * it, returns the sealed manifest. Decryption happens here, with the
 * fragment key, and the reveal exists only in memory.
 *
 * The decryption half mirrors `apps/pages/src/lib/vault/drop.ts` (the
 * canonical implementation); the ceremonies app does not depend on Pages, so
 * the AES-GCM + SHA-256 layout is reimplemented here and any change to the
 * drop manifest format must land in both.
 */

import { issuer } from "./issuer.js";

export type DropTextPayload = {
  kind: "text";
  name: string;
  text: string;
};

export type DropFilePayload = {
  kind: "file";
  name: string;
  contentType: string;
  bytes: Uint8Array;
};

export type DropPayload = DropTextPayload | DropFilePayload;

export type DropAcceptanceErrorCode =
  | "invalid_code"
  | "already_opened"
  | "expired"
  | "invalid"
  | "unreachable"
  | "tampered";

export class DropAcceptanceError extends Error {
  constructor(
    readonly code: DropAcceptanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DropAcceptanceError";
  }
}

const DROP_MANIFEST_KIND = "secret-drop";
const KEY_BYTES = 32;

/** The drop fragment carries token *and* key; a bare token is a normal claim. */
export function readDropFragment(
  hash: string,
): { token: string; key: string } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const token = params.get("token");
  const key = params.get("key");
  return token && key ? { token, key } : null;
}

/* -------------------------------------------------------------- opening */

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function b64UrlDecode(value: string): Uint8Array {
  return b64ToBytes(value.replaceAll("-", "+").replaceAll("_", "/"));
}

function invalidManifest(): DropAcceptanceError {
  return new DropAcceptanceError(
    "invalid",
    "This drop's payload is not in the shape a drop should have. Ask for a fresh link.",
  );
}

type DropChunk = { nonce: string; ciphertext: string; digest: string };

type DropManifest = {
  name: string;
  contentType: string;
  ciphertext: string;
  nonce: string;
  chunks?: DropChunk[];
  digest?: string;
};

function guardChunk(value: BoundaryValue): DropChunk {
  if (!isJsonObject(value)) throw invalidManifest();
  const { nonce, ciphertext, digest } = value;
  if (!isString(nonce) || !isString(ciphertext) || !isString(digest)) {
    throw invalidManifest();
  }
  return { nonce, ciphertext, digest };
}

/** Guard the server-returned manifest before anything is decoded from it. */
export function guardDropManifest(value: BoundaryValue): DropManifest {
  if (!isJsonObject(value)) throw invalidManifest();
  // The in-manifest discriminator is what makes this a drop at all.
  if (value.kind !== DROP_MANIFEST_KIND) throw invalidManifest();
  const { name, contentType, ciphertext, nonce, chunks, digest } = value;
  if (
    !isString(name) ||
    !isString(contentType) ||
    !isString(ciphertext) ||
    !isString(nonce)
  ) {
    throw invalidManifest();
  }
  const manifest: DropManifest = { name, contentType, ciphertext, nonce };
  if (chunks !== undefined) {
    if (!Array.isArray(chunks) || chunks.length === 0) throw invalidManifest();
    manifest.chunks = chunks.map(guardChunk);
    if (!isString(digest)) throw invalidManifest();
    manifest.digest = digest;
  }
  return manifest;
}

async function importDropKey(fragmentKey: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = b64UrlDecode(fragmentKey);
  } catch {
    throw new DropAcceptanceError(
      "invalid",
      "This drop link's decryption key is not readable. Ask for a fresh link.",
    );
  }
  if (raw.length !== KEY_BYTES) {
    throw new DropAcceptanceError(
      "invalid",
      "This drop link is missing its decryption key. Ask for a fresh link.",
    );
  }
  return crypto.subtle.importKey("raw", overlapCast(raw), "AES-GCM", false, [
    "decrypt",
  ]);
}

async function open(
  key: CryptoKey,
  nonce: string,
  ciphertext: string,
): Promise<Uint8Array> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: overlapCast(b64ToBytes(nonce)) },
      key,
      overlapCast(b64ToBytes(ciphertext)),
    );
    return new Uint8Array(plain);
  } catch {
    throw new DropAcceptanceError(
      "tampered",
      "This drop could not be opened — the ciphertext or the key does not match what was sealed.",
    );
  }
}

async function sha256B64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", overlapCast(bytes));
  let binary = "";
  for (const byte of new Uint8Array(digest))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function assertDigest(
  bytes: Uint8Array,
  expected: string,
  what: string,
): Promise<void> {
  if ((await sha256B64(bytes)) !== expected) {
    throw new DropAcceptanceError(
      "tampered",
      `This drop failed its ${what} digest check — the payload was altered after sealing.`,
    );
  }
}

/** Decrypt and digest-verify a presented drop manifest. */
export async function openDrop(
  value: BoundaryValue,
  fragmentKey: string,
): Promise<DropPayload> {
  const manifest = guardDropManifest(value);
  const key = await importDropKey(fragmentKey);

  if (manifest.chunks) {
    const parts: Uint8Array[] = [];
    let length = 0;
    for (const chunk of manifest.chunks) {
      const plain = await open(key, chunk.nonce, chunk.ciphertext);
      await assertDigest(plain, chunk.digest, "chunk");
      parts.push(plain);
      length += plain.length;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    // guardDropManifest requires the whole digest whenever chunks are present.
    await assertDigest(bytes, manifest.digest ?? "", "whole-payload");
    return {
      kind: "file",
      name: manifest.name,
      contentType: manifest.contentType,
      bytes,
    };
  }

  const plain = await open(key, manifest.nonce, manifest.ciphertext);
  return {
    kind: "text",
    name: manifest.name,
    text: new TextDecoder().decode(plain),
  };
}

/* ---------------------------------------------------------- presentation */

function obj(value: BoundaryValue): JsonObject {
  return isJsonObject(value) ? value : {};
}

async function fetchFnDefault(
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(url, init);
}

export const dropSeams = {
  fetchFn: fetchFnDefault,
};

/**
 * Present the claim with its user code and return the sealed manifest. The
 * code is verified server-side before the single-use transition, so a wrong
 * code does not burn the drop — but a successful present does, exactly once.
 */
export async function presentDrop(
  token: string,
  userCode: string,
): Promise<BoundaryValue> {
  let res: Response;
  try {
    res = await dropSeams.fetchFn(`${issuer}/v1/claims/present`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ token, userCode }),
    });
  } catch {
    throw new DropAcceptanceError(
      "unreachable",
      "The Identity API is not reachable from here.",
    );
  }
  const body: BoundaryValue = await res.json().catch(() => null);
  const code = obj(body).error;
  if (!res.ok) {
    if (code === "invalid_user_code") {
      throw new DropAcceptanceError(
        "invalid_code",
        "That code did not match this drop. Check it with the sender and try again.",
      );
    }
    if (code === "too_many_attempts") {
      throw new DropAcceptanceError(
        "invalid_code",
        "Too many wrong codes. Ask the sender for a fresh drop.",
      );
    }
    if (res.status === 410 || code === "EXPIRED") {
      throw new DropAcceptanceError(
        "expired",
        "This drop expired before it was opened.",
      );
    }
    // The single-use CAS refused a second presentation.
    if (res.status === 422 || res.status === 409) {
      throw new DropAcceptanceError(
        "already_opened",
        "This drop was already opened.",
      );
    }
    if (res.status === 401 || res.status === 404) {
      throw new DropAcceptanceError(
        "invalid",
        "This drop link is not valid. Ask the sender for a fresh one.",
      );
    }
    throw new DropAcceptanceError(
      "unreachable",
      `Opening the drop failed (${res.status}).`,
    );
  }
  if (!isJsonObject(body) || body.targetManifest === undefined) {
    throw new DropAcceptanceError(
      "invalid",
      "The drop's payload was missing from the answer.",
    );
  }
  return body.targetManifest;
}
