/**
 * A derived password (ADR 0173): a pure function of a root secret and a
 * counter, encoded into the shape the rules ask for. Nothing about the password
 * is stored, only the root, which is either in the clear in the sealed body or
 * (with *Include pepper*) sealed under a pepper.
 *
 * HKDF-SHA256 expands the root, with a fixed label and the counter, into a
 * stream; rejection sampling (`streamSource`, no modulo bias) draws the
 * characters from it. Rotating the counter gives a new password from the same
 * root without touching anything else.
 */

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import type { CharacterRules } from "./account.js";
import { b64ToBytes, bytesToB64 } from "./bytes.js";
import {
  type IndexSource,
  buildCharacters,
  ruleAlphabet,
} from "./character-rules.js";

const enc = new TextEncoder();
const LABEL = enc.encode("opensesame/derived/v1");
/** The most HKDF-Expand over SHA-256 can give: 255 blocks. */
const STREAM_BYTES = 255 * 32;
export const ROOT_SECRET_BYTES = 32;
export const MAX_COUNTER = 0xffffffff;

/** Uniform integers read from a fixed byte stream, four bytes a draw, no modulo bias. */
function streamSource(stream: Uint8Array): IndexSource {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.length);
  let at = 0;
  return {
    index(max) {
      const limit = Math.floor(2 ** 32 / max) * max;
      for (;;) {
        if (at + 4 > stream.length) throw new Error("The stream ran out.");
        const value = view.getUint32(at);
        at += 4;
        if (value < limit) return value % max;
      }
    },
  };
}

/** A fresh random root secret, base64. */
export function mintRootSecret(): string {
  const root = crypto.getRandomValues(new Uint8Array(ROOT_SECRET_BYTES));
  const b64 = bytesToB64(root);
  root.fill(0);
  return b64;
}

/** The password for `counter` under `rules`, from a root secret in base64. */
export function deriveCharacters(
  rootB64: string,
  counter: number,
  rules: CharacterRules,
): string {
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER) {
    throw new Error("The counter is out of range.");
  }
  ruleAlphabet(rules);
  const root = b64ToBytes(rootB64);
  if (root.length !== ROOT_SECRET_BYTES) {
    throw new Error("The root secret is not 32 bytes.");
  }
  const info = new Uint8Array(4);
  new DataView(info.buffer).setUint32(0, counter);
  const stream = hkdf(sha256, root, LABEL, info, STREAM_BYTES);
  try {
    return buildCharacters(rules, streamSource(stream));
  } finally {
    root.fill(0);
    stream.fill(0);
  }
}
