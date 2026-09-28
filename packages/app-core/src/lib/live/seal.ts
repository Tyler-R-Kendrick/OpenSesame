/**
 * The keys behind a live session's pairing codes (ADR 0148 §3).
 *
 * Two people pair their browsers with two codes. They pass them by hand, or
 * an optional carrier the owner named passes them on a topic only link
 * holders can name (`rendezvous.ts`). Either way, what protects them is here:
 *
 * - The **link secret** (32 random bytes) keys an outer seal on every
 *   request: whoever cannot open it does not hold the link, so what a
 *   stranger posts on a carrier is dropped and never counted as a guess.
 * - The **owner key** — an ECDH P-256 key minted per session, its public
 *   half in the link — and a fresh **joiner key** per request share a
 *   secret nobody else can derive. With the link secret and, in an invite
 *   session, the out-of-band **code**, it keys the request (only the owner
 *   reads it) and the reply (only that joiner reads it, and only the owner
 *   could have made it): AES-256-GCM under
 *   HKDF-SHA256(shared ‖ secret, salt = code, info = purpose).
 *
 * Every seal binds its context as additional data (the purpose, both keys,
 * and for a reply the request it answers), so a code cannot be replayed in
 * another place.
 */

const LABEL = "osm-live-v1";
/** The code alphabet ADR 0044 codes use: no vowels, no look-alikes. */
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const IV_BYTES = 12;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();

export { fromB64url, toB64url } from "./b64.js";
import { fromB64url, toB64url } from "./b64.js";

/** A fresh link secret: 32 random bytes, base64url. */
export function newLinkSecret(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A fresh id for one request: 16 random bytes, base64url. */
export function newRequestId(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** A fresh out-of-band code, `XXXX-XXXX`, uniform over the alphabet. */
export function newCode(): string {
  const letters: string[] = [];
  // Rejection sampling keeps every letter equally likely.
  const limit = 256 - (256 % CODE_LETTERS.length);
  while (letters.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && letters.length < 8)
        letters.push(CODE_LETTERS[byte % CODE_LETTERS.length] ?? "");
    }
  }
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
}

/**
 * `request-outer` is keyed by the link secret alone: whoever cannot open it
 * does not hold the link. `request` and `reply` add the code and the secret
 * the owner and one joiner share.
 */
export type Purpose = "request-outer" | "request" | "reply";

export type SealContext = Readonly<{
  /** The link secret, base64url. */
  secret: string;
  /** The normalized code in an invite session; null in an open one. */
  code: string | null;
  purpose: Purpose;
  /** What the seal is bound to: the owner key, the joiner's, a request id. */
  bound: readonly string[];
  /** The ECDH secret the owner and one joiner share, where there is one. */
  shared?: Uint8Array<ArrayBuffer> | null;
}>;

async function sealKey(context: SealContext): Promise<CryptoKey | null> {
  const secret = fromB64url(context.secret);
  if (!secret || secret.length !== 32) return null;
  const { shared } = context;
  let material = secret;
  if (shared) {
    material = new Uint8Array(shared.length + secret.length);
    material.set(shared);
    material.set(secret, shared.length);
  }
  const base = await crypto.subtle.importKey("raw", material, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(context.code ?? ""),
      info: encoder.encode(`${LABEL} ${context.purpose}`),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function additionalData(context: SealContext): Uint8Array<ArrayBuffer> {
  return encoder.encode([LABEL, context.purpose, ...context.bound].join("|"));
}

/** `plain`, sealed for `context`: base64url of iv ‖ ciphertext. */
export async function seal(
  context: SealContext,
  plain: string,
): Promise<string> {
  const key = await sealKey(context);
  if (!key) throw new Error("bad_link_secret");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(context) },
    key,
    encoder.encode(plain),
  );
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return toB64url(out);
}

/** The plaintext, or null when the seal is not for `context`. */
export async function unseal(
  context: SealContext,
  sealed: string,
): Promise<string | null> {
  const bytes = fromB64url(sealed);
  const key = await sealKey(context);
  if (!bytes || bytes.length <= IV_BYTES + 16 || !key) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(0, IV_BYTES),
        additionalData: additionalData(context),
      },
      key,
      bytes.slice(IV_BYTES),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}

/**
 * An ECDH P-256 key pair whose private half never leaves WebCrypto: the
 * owner's for the session (its public half in the link), and a joiner's for
 * one request.
 */
export type Keypair = Readonly<{
  /** The public key, raw uncompressed P-256 point, base64url (87 chars). */
  pub: string;
  /** The 32-byte secret shared with the holder of `peer`, or null. */
  shared: (peer: string) => Promise<Uint8Array<ArrayBuffer> | null>;
}>;

/** A fresh key pair; its private half is not extractable. */
export async function newKeypair(): Promise<Keypair> {
  const pair = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    pub: toB64url(raw),
    async shared(peer) {
      const point = fromB64url(peer);
      if (!point || point.length !== 65) return null;
      try {
        const key = await crypto.subtle.importKey(
          "raw",
          point,
          ECDH,
          false,
          [],
        );
        const bits = await crypto.subtle.deriveBits(
          { name: "ECDH", public: key },
          pair.privateKey,
          256,
        );
        return new Uint8Array(bits);
      } catch {
        return null;
      }
    },
  };
}
