/**
 * Byte-level helpers shared by every provenance check.
 *
 * They live in one module because the mistakes they prevent are the ones
 * that get made once per adapter otherwise: comparing MACs with `===`,
 * verifying a re-serialized body, base64url that forgot its padding, and
 * `JSON.parse` allowed to throw out of a verifier.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { type JsonValue, overlapCast } from "@opensesame/os-domain";

/**
 * Constant-time equality over bytes.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length is compared
 * first — and the early return is safe here because the length of a MAC is
 * public: an attacker already knows how long a SHA-256 digest is. What must
 * not leak is *where* two equal-length buffers first differ, and that is
 * exactly what the constant-time compare protects.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Constant-time equality for two secrets presented as text. */
export function secretsEqual(a: string, b: string): boolean {
  return bytesEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function concatBytes(parts: readonly Uint8Array[]): Buffer {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

export function utf8(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

export function sha256Hex(...parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

/**
 * Digest of a callback's delivery identity, for the replay ledger.
 *
 * Length-prefixed rather than concatenated, so a body ending where a
 * signature begins cannot be rearranged into the same digest as a different
 * body with a different signature. The ledger's whole job is to answer "have
 * I seen this exact delivery", and a collision there is a replayed approval.
 */
export function callbackDigest(
  domain: string,
  parts: readonly Uint8Array[],
): string {
  const hash = createHash("sha256");
  hash.update(utf8(domain));
  hash.update(utf8("\0"));
  for (const part of parts) {
    hash.update(utf8(`${part.length}\0`));
    hash.update(part);
  }
  return `v1:${hash.digest("hex")}`;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function base64UrlDecode(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

/**
 * Parse JSON without ever throwing.
 *
 * A verifier that throws on malformed input hands the caller a 500 where it
 * meant to hand them a refusal, and a 500 is a much more interesting reply
 * to an attacker than "no".
 */
export function parseJsonValue(text: string): JsonValue | undefined {
  try {
    const parsed: JsonValue = overlapCast(JSON.parse(text));
    return parsed;
  } catch {
    return undefined;
  }
}

/** Decode bytes as UTF-8 without throwing on invalid sequences. */
export function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}
