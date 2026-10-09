/** Raw BODY data parsing only; possession of a crypto key issues no authority. */
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import {
  type SealedBlob,
  b64ToBytes,
  bytesToB64,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { gcmOpen } from "@opensesame/vault-core/gcm.js";

export const MAX_HUMAN_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SAFE = "9007199254740991";
// Pinned VFS body path without importing its stateful storage implementation.
const BODY_PATH = "body";

function unavailable(): never {
  throw new Error("Human vault data is unavailable.");
}

function stringEnd(raw: string, start: number): number {
  for (let i = start + 1; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch === '"') return i;
    if (ch === "\\") i++;
  }
  return unavailable();
}

function assertInteger(raw: string, colon: number): void {
  let start = colon + 1;
  while (/\s/.test(raw.charAt(start)) && start < raw.length) start++;
  let end = start;
  while (end < raw.length && !/[\s,}\]]/.test(raw.charAt(end))) end++;
  const length = end - start;
  if (length > MAX_SAFE.length) unavailable();
  const token = raw.slice(start, end);
  if (
    !/^(?:0|[1-9][0-9]*)$/.test(token) ||
    (length === MAX_SAFE.length && token > MAX_SAFE)
  )
    unavailable();
}

type MetadataScan = {
  keys: Set<string>;
  depth: number;
  expectsKey: boolean;
  key?: string;
};

function readTopKey(
  raw: string,
  start: number,
  end: number,
  scan: MetadataScan,
): void {
  if (scan.depth !== 1 || !scan.expectsKey) return;
  const decoded: BoundaryValue = JSON.parse(raw.slice(start, end + 1));
  if (!isString(decoded) || scan.keys.has(decoded)) unavailable();
  scan.keys.add(decoded);
  scan.key = decoded;
  scan.expectsKey = false;
}

function visitContainer(ch: string, scan: MetadataScan): boolean {
  switch (ch) {
    case "{":
    case "[":
      scan.depth++;
      return true;
    case "}":
    case "]":
      scan.depth--;
      return true;
    default:
      return false;
  }
}

function visitMetadata(raw: string, index: number, scan: MetadataScan): void {
  if (scan.depth !== 1) return;
  const ch = raw.charAt(index);
  if (ch === ",") {
    scan.expectsKey = true;
    scan.key = undefined;
    return;
  }
  if (ch !== ":") return;
  if (scan.key === "v" || scan.key === "rev") assertInteger(raw, index);
  scan.key = undefined;
}

/**
 * Refuse decoded TOP-LEVEL duplicate keys and lossy v/rev numeric spellings.
 * Nested strings/numbers/keys are ordinary user data, not header metadata.
 * No recursive object construction or header depth policy is used. JSON.parse
 * still validates the complete grammar after this fixed linear lexical scan.
 */
function assertBodyMetadata(raw: string): void {
  if (raw.length > MAX_HUMAN_BODY_BYTES) unavailable();
  let first = 0;
  while (first < raw.length && /\s/.test(raw.charAt(first))) first++;
  if (raw.charAt(first) !== "{") unavailable();
  const scan: MetadataScan = { keys: new Set(), depth: 0, expectsKey: true };
  for (let i = first; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch === '"') {
      const end = stringEnd(raw, i);
      readTopKey(raw, i, end, scan);
      i = end;
    } else if (!visitContainer(ch, scan)) {
      visitMetadata(raw, i, scan);
    }
  }
}

function sealedBytes(
  text: string,
  minimum: number,
  maximum: number,
): Uint8Array {
  if (text.length > Math.ceil(maximum / 3) * 4) unavailable();
  const bytes = b64ToBytes(text);
  if (
    bytes.length < minimum ||
    bytes.length > maximum ||
    bytesToB64(bytes) !== text
  )
    unavailable();
  return bytes;
}

/** Fixed actual AEAD and fatal UTF-8 data decode; no unbound or legacy fallback. */
export async function openBoundHumanVaultBodyData(
  key: CryptoKey,
  body: SealedBlob,
  tomb: string,
): Promise<BoundaryValue> {
  const iv = sealedBytes(body.ivB64, 12, 12);
  const ciphertext = sealedBytes(body.ctB64, 16, MAX_HUMAN_BODY_BYTES);
  const aad = new TextEncoder().encode(vaultSealBinding(tomb, BODY_PATH));
  const plaintext = await gcmOpen(key, iv, ciphertext, aad);
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    assertBodyMetadata(raw);
    const value: BoundaryValue = JSON.parse(raw);
    return value;
  } finally {
    plaintext.fill(0);
  }
}
