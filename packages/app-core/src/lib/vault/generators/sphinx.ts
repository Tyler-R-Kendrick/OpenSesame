/**
 * The `sphinx` generator (ADR 0168 §5): a password recomputed at every use from
 * a master input the person types and an OPRF key that stays in the vault.
 *
 * The protocol is RFC 9497 (`ristretto255-SHA512`, base OPRF mode) as
 * implemented by `@noble/curves`; nothing here is protocol code of our own. The
 * client blinds a canonical encoding of the input, an `OprfEvaluator` (a port)
 * evaluates it under the key, the client finalizes to 64 bytes, and those are
 * encoded into the password by HKDF-SHA256 and rejection sampling into the
 * rule's pools.
 *
 * Nothing in an error message here names the master input, the key or the
 * password.
 */

import { ristretto255_oprf } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import {
  type CharacterRules,
  type SphinxGenerator,
  b64ToBytes,
  bytesToB64,
} from "@opensesame/vault-core";
import {
  type IndexSource,
  buildCharacters,
  ruleAlphabet,
} from "./characters.js";

const oprf = ristretto255_oprf.oprf;
const enc = new TextEncoder();

const INPUT_LABEL = "opensesame/sphinx/v1";
const ENCODE_INFO = enc.encode("opensesame/sphinx/v1/encode");
/** The most HKDF-Expand over SHA-256 can give: 255 blocks. */
const STREAM_BYTES = 255 * 32;
const MAX_COUNTER = 0xffffffff;

/** Evaluates a blinded element under the OPRF key. A port: a Host or device may stand behind it. */
export interface OprfEvaluator {
  evaluate(blinded: Uint8Array): Promise<Uint8Array>;
}

export type SphinxInput = {
  master: string;
  realm: string;
  username: string;
  counter: number;
  rules: CharacterRules;
};

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

/**
 * ("opensesame/sphinx/v1", master NFKC, realm, username, counter), each field
 * length-prefixed with four big-endian bytes, so no value can run into the next.
 */
export function sphinxInputBytes(
  input: Pick<SphinxInput, "master" | "realm" | "username" | "counter">,
): Uint8Array {
  if (input.master === "") throw new Error("A master input is required.");
  if (
    !Number.isInteger(input.counter) ||
    input.counter < 0 ||
    input.counter > MAX_COUNTER
  ) {
    throw new Error("The Sphinx counter is out of range.");
  }
  const counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, input.counter);
  const fields = [
    enc.encode(INPUT_LABEL),
    enc.encode(input.master.normalize("NFKC")),
    enc.encode(input.realm),
    enc.encode(input.username),
    counter,
  ].map(lengthPrefixed);
  const out = new Uint8Array(fields.reduce((sum, f) => sum + f.length, 0));
  let at = 0;
  for (const field of fields) {
    out.set(field, at);
    at += field.length;
    field.fill(0);
  }
  return out;
}

/** Uniform integers read from a fixed byte stream, four bytes a draw, no modulo bias. */
function streamSource(stream: Uint8Array): IndexSource {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.length);
  let at = 0;
  return {
    index(max) {
      const limit = Math.floor(2 ** 32 / max) * max;
      for (;;) {
        if (at + 4 > stream.length)
          throw new Error("The Sphinx stream ran out.");
        const value = view.getUint32(at);
        at += 4;
        if (value < limit) return value % max;
      }
    },
  };
}

/** Holds `k` in memory for one call and never logs it. */
export function vaultEvaluator(oprfKeyB64: string): OprfEvaluator {
  return {
    async evaluate(blinded) {
      const key = b64ToBytes(oprfKeyB64);
      try {
        return oprf.blindEvaluate(key, blinded);
      } finally {
        key.fill(0);
      }
    },
  };
}

/** A fresh random ristretto255 OPRF key, base64. */
export function mintOprfKey(): string {
  const { secretKey } = oprf.generateKeyPair();
  const b64 = bytesToB64(secretKey);
  secretKey.fill(0);
  return b64;
}

export function rotateSphinx(generator: SphinxGenerator): SphinxGenerator {
  return { ...generator, counter: generator.counter + 1 };
}

async function oprfOutput(
  input: Uint8Array,
  evaluator: OprfEvaluator,
): Promise<Uint8Array> {
  const { blind, blinded } = oprf.blind(input);
  try {
    const evaluated = await evaluator.evaluate(blinded);
    return oprf.finalize(input, blind, evaluated);
  } finally {
    blind.fill(0);
  }
}

export async function sphinxPassword(
  input: SphinxInput,
  evaluator: OprfEvaluator,
): Promise<string> {
  ruleAlphabet(input.rules);
  const bytes = sphinxInputBytes(input);
  let output: Uint8Array | undefined;
  let stream: Uint8Array | undefined;
  try {
    output = await oprfOutput(bytes, evaluator);
    stream = hkdf(sha256, output, undefined, ENCODE_INFO, STREAM_BYTES);
    return buildCharacters(input.rules, streamSource(stream));
  } catch {
    // The cause of a failure here may sit next to the input; say only what failed.
    throw new Error("The Sphinx password could not be computed.");
  } finally {
    bytes.fill(0);
    output?.fill(0);
    stream?.fill(0);
  }
}
