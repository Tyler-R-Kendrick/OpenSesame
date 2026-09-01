/**
 * SD-JWT and SD-JWT+KB structure, written by hand.
 *
 * There is a pile of SD-JWT libraries and this package deliberately uses none
 * of them. The format's security rests on four rules that are three lines of
 * code each and catastrophic to get wrong, and a dependency that gets one of
 * them wrong fails open — the credential still verifies, it just says
 * something the issuer never signed:
 *
 * 1. **The digest is over the base64url text, not the bytes it encodes**
 *    (RFC 9901 §4.2.3). Hashing the decoded JSON instead would still produce a
 *    self-consistent scheme; it just would not be the one the issuer used.
 * 2. **Every presented disclosure must be consumed.** A disclosure that
 *    matches no digest in the payload is not "extra data to ignore" — it is a
 *    claim being smuggled past the issuer's signature, and RFC 9901 §7.3
 *    requires rejecting the whole presentation.
 * 3. **A digest may appear only once.** Otherwise one disclosure can be
 *    installed at two places in the claim set.
 * 4. **A disclosed name may not overwrite a claim already present.** The
 *    plaintext claims are the ones the issuer chose not to make optional;
 *    letting a disclosure land on top of `iss` or `vct` would let the holder
 *    rewrite them.
 *
 * All four are enforced below, and the enforcement is what the adversarial
 * tests aim at. What this file does *not* do is verify signatures — that is
 * `jose.ts` — or decide whether the claims mean anything, which is `verify.ts`.
 *
 * There is a fifth rule that is not about SD-JWT at all but about the language
 * the resolver is written in, and it is enforced here because this is where the
 * claim object is built: **a claim may not be named `__proto__`.** Assigning
 * that key on an object literal runs the inherited setter instead of defining a
 * property, so the value never becomes an own property — it silently replaces
 * the object's prototype. Rule 4 is then structurally unreachable for that one
 * name, because `Object.hasOwn(out, "__proto__")` cannot become true no matter
 * what was assigned, and the resulting claim set answers `claims.isAdmin` with
 * a value that appears in no `Object.keys` listing and in no `JSON.stringify`
 * output. Refusing the name outright is the fix rather than a null-prototype
 * accumulator: the object we return is handed to callers who will spread,
 * merge and re-serialize it, and each of those re-enters the same trap. No
 * credential needs the name, so no credential gets it.
 */

import {
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type HashAlgorithm,
  decodeBase64url,
  decodeUtf8,
  hashStringToBase64url,
} from "./encoding.js";

/**
 * Hard ceiling on nesting depth while resolving disclosures.
 *
 * The claim tree is attacker-shaped: a wallet chooses how deeply its
 * disclosures nest, and a recursive resolver with no limit turns that into a
 * stack overflow — a crash in the middle of a verifier, reached before any
 * signature has been checked. Sixteen is far beyond any real credential.
 */
const MAX_CLAIM_DEPTH = 16;

/** Ceiling on how many disclosures one presentation may carry. */
const MAX_DISCLOSURES = 256;

/** The structural pieces of an SD-JWT+KB, still unverified. */
export interface ParsedSdJwt {
  /** The issuer-signed JWT, compact serialization. */
  readonly issuerJwt: string;
  /** Disclosure strings exactly as received, in presentation order. */
  readonly disclosures: readonly string[];
  /** The KB-JWT, or null when the final tilde-separated element was empty. */
  readonly keyBindingJwt: string | null;
  /**
   * `<issuer JWT>~<D.1>~...~<D.N>~` — the exact string `sd_hash` covers.
   *
   * Reconstructed from the received segments rather than sliced out of the
   * input so that a presentation with an odd separator layout cannot make the
   * hashed region differ from the region actually parsed.
   */
  readonly keyBindingInput: string;
}

/**
 * Split an SD-JWT+KB on `~`.
 *
 * RFC 9901 §4: an SD-JWT always ends with a trailing `~`, so an SD-JWT with no
 * KB-JWT has an empty final element and an SD-JWT+KB has the KB-JWT there.
 * That single character is the only thing distinguishing "the holder proved
 * possession" from "the holder did not", which is why the empty case is
 * returned as an explicit `null` rather than an absent field.
 */
export function parseSdJwt(compact: string): ParsedSdJwt {
  const parts = compact.split("~");
  if (parts.length < 2) throw new SyntaxError("not an SD-JWT");
  const issuerJwt = parts[0];
  if (issuerJwt === undefined || issuerJwt.length === 0) {
    throw new SyntaxError("not an SD-JWT");
  }
  const last = parts[parts.length - 1];
  if (last === undefined) throw new SyntaxError("not an SD-JWT");
  const disclosures = parts.slice(1, parts.length - 1);
  if (disclosures.length > MAX_DISCLOSURES) {
    throw new SyntaxError("too many disclosures");
  }
  for (const disclosure of disclosures) {
    if (disclosure.length === 0) throw new SyntaxError("empty disclosure");
  }
  return {
    issuerJwt,
    disclosures,
    keyBindingJwt: last.length === 0 ? null : last,
    keyBindingInput: `${[issuerJwt, ...disclosures].join("~")}~`,
  };
}

/** One decoded disclosure, paired with the digest that references it. */
export interface Disclosure {
  /** The received base64url text. The digest is taken over this. */
  readonly encoded: string;
  readonly digest: string;
  /** Present for an object property; null for an array element. */
  readonly name: string | null;
  readonly value: JsonValue;
}

/**
 * Decode and digest each disclosure.
 *
 * A disclosure is `[salt, name, value]` for an object property or
 * `[salt, value]` for an array element (RFC 9901 §4.2.1, §4.2.2). Anything
 * else — a two-element array whose first element is not a string, a
 * four-element array, a bare object — is refused rather than coerced, because
 * a resolver that guesses will happily install a claim under a name the issuer
 * never digested.
 */
export function readDisclosures(
  encoded: readonly string[],
  alg: HashAlgorithm,
): readonly Disclosure[] {
  const seen = new Set<string>();
  const out: Disclosure[] = [];
  for (const text of encoded) {
    const parsed: JsonValue = JSON.parse(decodeUtf8(decodeBase64url(text)));
    if (!Array.isArray(parsed))
      throw new SyntaxError("disclosure is not an array");
    const salt = parsed[0];
    if (!isString(salt))
      throw new SyntaxError("disclosure salt is not a string");
    let name: string | null;
    let value: JsonValue;
    if (parsed.length === 3) {
      const claimName = parsed[1];
      if (!isString(claimName)) {
        throw new SyntaxError("disclosure name is not a string");
      }
      // RFC 9901 §4.1: `_sd` and `...` are reserved for digest carriage. A
      // disclosure claiming either name would rewrite the machinery that
      // decides which claims exist at all. `__proto__` is reserved by
      // JavaScript for the same kind of reason — see the fifth rule in the
      // module header — and is refused here, before a digest is even computed,
      // so it cannot reach an assignment anywhere downstream.
      if (isReservedClaimName(claimName)) {
        throw new SyntaxError("disclosure name is reserved");
      }
      name = claimName;
      value = parsed[2] ?? null;
    } else if (parsed.length === 2) {
      name = null;
      value = parsed[1] ?? null;
    } else {
      throw new SyntaxError("disclosure has the wrong arity");
    }
    const digest = hashStringToBase64url(alg, text);
    // Rule 3. Two identical disclosures would each satisfy the same digest and
    // the "every disclosure was used" accounting below would still balance.
    if (seen.has(digest)) throw new SyntaxError("duplicate disclosure");
    seen.add(digest);
    out.push({ encoded: text, digest, name, value });
  }
  return out;
}

/**
 * Claim names no SD-JWT may carry, disclosed or in the clear.
 *
 * The first two are RFC 9901 §4.1's digest machinery. The third is
 * `Object.prototype`'s setter — a name that cannot be assigned onto an object
 * literal without changing the object rather than its contents.
 */
const RESERVED_CLAIM_NAMES: readonly string[] = ["_sd", "...", "__proto__"];

function isReservedClaimName(name: string): boolean {
  return RESERVED_CLAIM_NAMES.includes(name);
}

/**
 * Rebuild the claim set the issuer signed, with the presented disclosures
 * substituted in.
 *
 * Undisclosed digests — real claims the holder withheld, and decoys the issuer
 * padded with — simply have no matching disclosure and vanish. That is the
 * whole point of the format and is not an error. The error is the reverse: a
 * disclosure that nothing referenced, which `used` accounting catches.
 */
export function resolveDisclosures(
  payload: JsonObject,
  disclosures: readonly Disclosure[],
): JsonObject {
  const byDigest = new Map<string, Disclosure>();
  for (const disclosure of disclosures)
    byDigest.set(disclosure.digest, disclosure);
  const used = new Set<string>();
  const claimed = new Set<string>();

  const resolveValue = (value: JsonValue, depth: number): JsonValue => {
    if (depth > MAX_CLAIM_DEPTH) throw new SyntaxError("claim tree too deep");
    if (Array.isArray(value)) return resolveArray(value, depth);
    if (isJsonObject(value)) return resolveObject(value, depth);
    return value;
  };

  const resolveArray = (
    items: readonly JsonValue[],
    depth: number,
  ): JsonValue[] => {
    const out: JsonValue[] = [];
    for (const item of items) {
      if (isJsonObject(item)) {
        const keys = Object.keys(item);
        const pointer = item["..."];
        // RFC 9901 §4.2.4.2: an array-element digest is an object whose *only*
        // member is `...`. Accepting it alongside other members would let a
        // disclosure be injected while carrying sibling data past the issuer.
        if (keys.length === 1 && keys[0] === "..." && isString(pointer)) {
          if (claimed.has(pointer)) throw new SyntaxError("digest reused");
          claimed.add(pointer);
          const disclosure = byDigest.get(pointer);
          if (disclosure === undefined) continue;
          if (disclosure.name !== null) {
            throw new SyntaxError("object disclosure used as an array element");
          }
          used.add(pointer);
          out.push(resolveValue(disclosure.value, depth + 1));
          continue;
        }
      }
      out.push(resolveValue(item, depth + 1));
    }
    return out;
  };

  const resolveObject = (source: JsonObject, depth: number): JsonObject => {
    const out: MutableJsonObject = {};
    for (const key of Object.keys(source)) {
      if (key === "_sd" || key === "_sd_alg") continue;
      // The plaintext half of the same rule, applied at every depth: the
      // recursion re-enters here for nested objects and for the value of every
      // disclosure. `readDisclosures` refuses a *disclosed* reserved name, and
      // this refuses one the issuer signed in the clear — a plaintext `...`
      // outside an array slot, or the `__proto__` the accumulator below cannot
      // hold as an own property.
      if (isReservedClaimName(key)) {
        throw new SyntaxError("claim name is reserved");
      }
      const value = source[key];
      if (value === undefined) continue;
      out[key] = resolveValue(value, depth + 1);
    }
    const digests = source._sd;
    if (digests !== undefined) {
      if (!Array.isArray(digests)) throw new SyntaxError("_sd is not an array");
      for (const digest of digests) {
        if (!isString(digest))
          throw new SyntaxError("_sd entry is not a string");
        if (claimed.has(digest)) throw new SyntaxError("digest reused");
        claimed.add(digest);
        const disclosure = byDigest.get(digest);
        if (disclosure === undefined) continue;
        if (disclosure.name === null) {
          throw new SyntaxError("array disclosure used as an object property");
        }
        // Rule 4. `out` already holds every plaintext claim at this level, so
        // a collision here is a disclosure trying to overwrite something the
        // issuer published in the clear.
        if (Object.hasOwn(out, disclosure.name)) {
          throw new SyntaxError("disclosure collides with a plaintext claim");
        }
        used.add(digest);
        out[disclosure.name] = resolveValue(disclosure.value, depth + 1);
      }
    }
    return out;
  };

  const resolved = resolveObject(payload, 0);
  // Rule 2.
  if (used.size !== disclosures.length) {
    throw new SyntaxError("presentation carries an unreferenced disclosure");
  }
  return resolved;
}
