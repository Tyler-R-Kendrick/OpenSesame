import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Secret drop transport (docs/design/secret-drop.md, ADR 0062).
 *
 * A drop shares a secret or a small file exactly once: the browser seals the
 * payload under a fresh AES-GCM-256 drop key, the sealed manifest rides a
 * claim session (`type: "resource_bundle"`, in-manifest discriminator
 * `kind: "secret-drop"`), and the key travels in the drop link's `#key=`
 * fragment — it is never sent to any server. Presentation is single-use and
 * gated by the claim's user code, so the server serves the ciphertext
 * exactly once, to whoever holds link + code.
 *
 * File payloads follow the ADR 0054 attachment layout, adapted to WebCrypto:
 * 1 MiB plaintext chunks, each sealed on its own, a SHA-256 digest per chunk
 * and one for the whole payload (SHA-256 stands in for BLAKE3 — WebCrypto
 * has no BLAKE3). v1 caps total ciphertext at 1 MiB.
 */

import {
  ensureIdentitySession,
  identityBase,
  identityFetch,
} from "../identity.js";
import { b64ToBytes, bytesToB64, randomBytes } from "./crypto.js";
import {
  type DropItem,
  type DropKeptCopy,
  type VaultItem,
  createItem,
  dropTerminal,
} from "./model.js";

/** Plaintext bytes per chunk — the ADR 0054 chunk size. */
export const DROP_CHUNK_BYTES = 1_048_576;
/** Hard ceiling on one drop's total sealed bytes (the claim manifest is JSON). */
export const MAX_DROP_CIPHERTEXT_BYTES = 1_048_576;

const DROP_MANIFEST_KIND = "secret-drop";
/** Claim target type a drop session is created under; the manifest discriminates. */
const DROP_CLAIM_TYPE = "resource_bundle";
const KEY_BYTES = 32;
const IV_BYTES = 12;

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

export type DropChunk = {
  /** AES-GCM iv for this chunk, base64. */
  nonce: string;
  /** Sealed chunk bytes, base64. */
  ciphertext: string;
  /** SHA-256 of the plaintext chunk, base64. */
  digest: string;
};

export type DropManifest = {
  kind: "secret-drop";
  name: string;
  contentType: string;
  /** Whole-blob ciphertext (text drops). Empty when the payload is chunked. */
  ciphertext: string;
  /** AES-GCM iv for the whole-blob ciphertext. Empty for chunked payloads. */
  nonce: string;
  /** Chunked file payload: 1 MiB plaintext chunks, each sealed on its own. */
  chunks?: DropChunk[];
  /** SHA-256 of the whole plaintext payload, base64 (chunked payloads). */
  digest?: string;
};

/** Terminal states purge the vault's drop record; `pending` keeps waiting. */
export type DropState = "pending" | "consumed" | "expired";

export type DropSession = {
  claimId: string;
  bearerToken: string;
  userCode: string;
  /** Ceremonies claim URL the recipient opens; `dropLink` adds the fragment. */
  verifyUrl: string;
  expiresAt: string;
};

export type DropErrorCode =
  | "payload_too_large"
  | "invalid_manifest"
  | "invalid_key"
  | "tampered"
  | "unreachable"
  | "refused";

export class DropError extends Error {
  constructor(
    readonly code: DropErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DropError";
  }
}

/* --------------------------------------------------------------- sealing */

function b64UrlEncode(bytes: Uint8Array): string {
  return bytesToB64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function b64UrlDecode(value: string): Uint8Array {
  return b64ToBytes(value.replaceAll("-", "+").replaceAll("_", "/"));
}

async function importDropKey(fragmentKey: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = b64UrlDecode(fragmentKey);
  } catch {
    throw new DropError(
      "invalid_key",
      "This drop link's decryption key is not readable. Ask for a fresh link.",
    );
  }
  if (raw.length !== KEY_BYTES) {
    throw new DropError(
      "invalid_key",
      "This drop link is missing its decryption key. Ask for a fresh link.",
    );
  }
  return crypto.subtle.importKey("raw", overlapCast(raw), "AES-GCM", false, [
    "decrypt",
  ]);
}

type SealedPart = { nonce: string; ciphertext: string };

async function seal(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<SealedPart> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: overlapCast(iv) },
    key,
    overlapCast(plaintext),
  );
  return {
    nonce: bytesToB64(iv),
    ciphertext: bytesToB64(new Uint8Array(ct)),
  };
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
    throw new DropError(
      "tampered",
      "This drop could not be opened — the ciphertext or the key does not match what was sealed.",
    );
  }
}

async function sha256B64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", overlapCast(bytes));
  return bytesToB64(new Uint8Array(digest));
}

function sealedSize(ciphertextB64: string): number {
  return b64ToBytes(ciphertextB64).length;
}

function assertWithinCap(totalCiphertext: number): void {
  if (totalCiphertext > MAX_DROP_CIPHERTEXT_BYTES) {
    throw new DropError(
      "payload_too_large",
      "Drops are limited to 1 MiB of encrypted payload. Shorten the text or share a smaller file.",
    );
  }
}

export type SealedDrop = {
  manifest: DropManifest;
  /** Base64url raw drop key for the link's `#key=` fragment — never a request body. */
  fragmentKey: string;
};

/**
 * Seal a payload under a fresh drop key. The returned `fragmentKey` is the
 * base64url raw key for the link's `#key=` fragment — it must never appear
 * in a request body.
 */
export async function sealDrop(payload: DropPayload): Promise<SealedDrop> {
  const rawKey = randomBytes(KEY_BYTES);
  const key = await crypto.subtle.importKey(
    "raw",
    overlapCast(rawKey),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  try {
    if (payload.kind === "text") {
      const sealed = await seal(key, new TextEncoder().encode(payload.text));
      assertWithinCap(sealedSize(sealed.ciphertext));
      return {
        manifest: {
          kind: DROP_MANIFEST_KIND,
          name: payload.name,
          contentType: "text/plain",
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
        },
        fragmentKey: b64UrlEncode(rawKey),
      };
    }

    const chunks: DropChunk[] = [];
    let total = 0;
    for (
      let offset = 0;
      offset < payload.bytes.length;
      offset += DROP_CHUNK_BYTES
    ) {
      const chunk = payload.bytes.slice(offset, offset + DROP_CHUNK_BYTES);
      const sealed = await seal(key, chunk);
      total += sealedSize(sealed.ciphertext);
      assertWithinCap(total);
      chunks.push({
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        digest: await sha256B64(chunk),
      });
    }
    return {
      manifest: {
        kind: DROP_MANIFEST_KIND,
        name: payload.name,
        contentType: payload.contentType || "application/octet-stream",
        ciphertext: "",
        nonce: "",
        chunks,
        digest: await sha256B64(payload.bytes),
      },
      fragmentKey: b64UrlEncode(rawKey),
    };
  } finally {
    rawKey.fill(0);
  }
}

/* -------------------------------------------------------------- opening */

function guardChunk(value: BoundaryValue): DropChunk {
  if (!isJsonObject(value)) throw invalidManifest();
  const { nonce, ciphertext, digest } = value;
  if (!isString(nonce) || !isString(ciphertext) || !isString(digest)) {
    throw invalidManifest();
  }
  return { nonce, ciphertext, digest };
}

function invalidManifest(): DropError {
  return new DropError(
    "invalid_manifest",
    "This drop's payload is not in the shape a drop should have. Ask for a fresh link.",
  );
}

/** Guard the server-returned manifest before anything is decoded from it. */
export function guardManifest(value: BoundaryValue): DropManifest {
  if (!isJsonObject(value)) throw invalidManifest();
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
  const manifest: DropManifest = {
    kind: DROP_MANIFEST_KIND,
    name,
    contentType,
    ciphertext,
    nonce,
  };
  if (chunks !== undefined) {
    if (!Array.isArray(chunks) || chunks.length === 0) throw invalidManifest();
    manifest.chunks = chunks.map(guardChunk);
    if (!isString(digest)) throw invalidManifest();
    manifest.digest = digest;
  }
  return manifest;
}

async function assertDigest(
  bytes: Uint8Array,
  expected: string,
  what: string,
): Promise<void> {
  if ((await sha256B64(bytes)) !== expected) {
    throw new DropError(
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
  const manifest = guardManifest(value);
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
    // guardManifest requires the whole digest whenever chunks are present.
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

/* ------------------------------------------------------ claim transport */

function obj(value: BoundaryValue): JsonObject {
  return isJsonObject(value) ? value : {};
}

/** Claim lifecycle states the server reports, mapped onto drop states. */
export function dropStateFromClaim(status: string): DropState {
  switch (status) {
    case "pending":
      return "pending";
    case "presented":
    case "authenticated":
    case "reviewed":
    case "completed":
      // Presentation is the single-use burn: from the drop's side the payload
      // was taken the moment the claim was presented.
      return "consumed";
    case "expired":
    case "denied":
    case "revoked":
      return "expired";
    default:
      throw new DropError(
        "refused",
        "The Identity API reported a claim state this app does not know.",
      );
  }
}

function ceremoniesBaseDefault(): string {
  // The ceremonies app is a separate deploy; the Pages runtime config has no
  // key for it yet, so the build-time override mirrors ceremonies' own
  // issuer.ts default (its dev port).
  const fromEnv: BoundaryValue = import.meta.env?.VITE_OPENSESAME_CEREMONIES;
  return isString(fromEnv) && fromEnv.trim()
    ? fromEnv.trim().replace(/\/$/, "")
    : "http://127.0.0.1:5181";
}

async function createClaimDefault(
  manifest: DropManifest,
  ttlMs: number,
): Promise<DropSession> {
  // Drops must work for guests: the claim plane needs a principal, and a
  // provisional one is the platform's anonymous identity — mint it silently
  // rather than asking the user to "connect" anything.
  try {
    await ensureIdentitySession();
  } catch {
    throw new DropError(
      "unreachable",
      `The Identity API at ${identityBase()} could not be reached. A drop needs it to hold the sealed payload for the recipient.`,
    );
  }
  let res: Response;
  try {
    res = await identityFetch("/v1/claims", {
      method: "POST",
      body: JSON.stringify({
        type: DROP_CLAIM_TYPE,
        targetManifest: manifest,
        ttlSeconds: Math.max(1, Math.round(ttlMs / 1000)),
      }),
    });
  } catch {
    throw new DropError(
      "unreachable",
      `The Identity API at ${identityBase()} could not be reached. Connect and try again.`,
    );
  }
  if (!res.ok) {
    const detail = obj(await res.json().catch(() => null));
    throw new DropError(
      "refused",
      isString(detail.hint)
        ? detail.hint
        : res.status === 401 || res.status === 403
          ? "The Identity API refused the drop session. Try again in a moment."
          : `The Identity API answered ${res.status} — the drop was not created.`,
    );
  }
  const body = obj(await res.json());
  const claimId = body.claimId;
  const bearerToken = body.claimToken;
  const userCode = body.userCode;
  const expiresAt = body.expiresAt;
  if (
    !isString(claimId) ||
    !isString(bearerToken) ||
    !isString(userCode) ||
    !isString(expiresAt)
  ) {
    throw new DropError(
      "refused",
      "The Identity API's answer did not look like a claim session.",
    );
  }
  return {
    claimId,
    bearerToken,
    userCode,
    verifyUrl: `${dropSeams.ceremoniesBase()}/claim`,
    expiresAt,
  };
}

async function pollClaimDefault(
  claimId: string,
  bearerToken: string,
): Promise<DropState> {
  let res: Response;
  try {
    res = await identityFetch(
      `/v1/claims/${encodeURIComponent(claimId)}/poll`,
      { headers: { "x-claim-token": bearerToken } },
    );
  } catch {
    throw new DropError(
      "unreachable",
      `The Identity API at ${identityBase()} could not be reached.`,
    );
  }
  if (res.status === 401) {
    throw new DropError(
      "refused",
      "The Identity API refused this drop's claim token.",
    );
  }
  // An open claim polls as 400 authorization_pending and an expired one as
  // 410 — both bodies still name the claim state, so read it either way.
  const body = obj(await res.json().catch(() => null));
  const nested = obj(body.claim).state;
  const status = isString(body.status)
    ? body.status
    : isString(nested)
      ? nested
      : null;
  if (status === null) {
    throw new DropError(
      "refused",
      "The Identity API's poll answer did not name a claim state.",
    );
  }
  return dropStateFromClaim(status);
}

export const dropSeams = {
  createClaim: createClaimDefault,
  pollClaim: pollClaimDefault,
  ceremoniesBase: ceremoniesBaseDefault,
};

/** Create the single-use, time-boxed claim session carrying this manifest. */
export function createDropSession(
  manifest: DropManifest,
  ttlMs: number,
): Promise<DropSession> {
  return dropSeams.createClaim(manifest, ttlMs);
}

/** Map the claim's current state onto the drop record's lifecycle. */
export function pollDrop(
  claimId: string,
  bearerToken: string,
): Promise<DropState> {
  return dropSeams.pollClaim(claimId, bearerToken);
}

/**
 * The shareable link: ceremonies claim URL with the bearer and the drop key
 * in the fragment. The fragment never leaves the browser — no request line,
 * log, or Referer ever carries it.
 */
export function dropLink(
  verifyUrl: string,
  bearerToken: string,
  fragmentKey: string,
): string {
  return `${verifyUrl}#token=${encodeURIComponent(bearerToken)}&key=${fragmentKey}`;
}

/* ------------------------------------------------------------- creation */

export type CreatedDrop = {
  /** The vault record — no payload inside unless `keepCopy` was asked for. */
  record: DropItem;
  link: string;
  userCode: string;
};

/**
 * Seal a payload, create its claim session, and build the vault record for
 * it. The record still has to be saved by the caller, so a failed save never
 * leaves a drop nobody can track.
 */
export async function createDrop(input: {
  name: string;
  payload: DropPayload;
  ttlMs: number;
  keepCopy: boolean;
}): Promise<CreatedDrop> {
  const { manifest, fragmentKey } = await sealDrop(input.payload);
  const session = await createDropSession(manifest, input.ttlMs);
  const record: DropItem = {
    ...createItem("drop", input.name),
    state: "pending",
    claimId: session.claimId,
    bearerToken: session.bearerToken,
    expiresAt: session.expiresAt,
    ...(input.keepCopy
      ? { keptCopy: keptCopyFromPayload(input.payload) }
      : undefined),
  };
  return {
    record,
    link: dropLink(session.verifyUrl, session.bearerToken, fragmentKey),
    userCode: session.userCode,
  };
}

/* ----------------------------------------------------------- kept copies */

/** JSON-safe form of a payload for the drop record's optional kept copy. */
export function keptCopyFromPayload(payload: DropPayload): DropKeptCopy {
  if (payload.kind === "text") {
    return { kind: "text", text: payload.text };
  }
  return {
    kind: "file",
    name: payload.name,
    contentType: payload.contentType,
    dataB64: bytesToB64(payload.bytes),
  };
}

/* -------------------------------------------------------------- disposal */

/**
 * Poll one drop record and purge it once nothing can open the drop again:
 * the claim reached a terminal state, or the TTL already lapsed locally.
 * Only an affirmative terminal answer purges — a network or refusal failure
 * leaves the record for the next read, so a shaky connection never burns a
 * live drop.
 */
export async function sweepDrop(
  item: DropItem,
  purge: () => Promise<void>,
  now = new Date(),
): Promise<void> {
  if (dropTerminal(item, now)) {
    await purge();
    return;
  }
  try {
    const state = await pollDrop(item.claimId, item.bearerToken);
    if (state !== "pending") await purge();
  } catch {
    // Offline or refused: the record stays; the next vault read retries.
  }
}

/** Sweep every live drop record after the vault body is read. */
export async function sweepDrops(
  items: VaultItem[],
  purge: (id: string) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    if (item.kind !== "drop" || item.deletedAt !== null) continue;
    await sweepDrop(item, () => purge(item.id));
  }
}
