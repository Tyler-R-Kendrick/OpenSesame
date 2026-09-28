/**
 * The keys behind a live session's pairing codes (ADR 0148 §3).
 *
 * Two people pair their browsers by passing each other two codes, by
 * whatever channel they already share. Neither code travels through any
 * server of ours or anyone's, so what protects them is here:
 *
 * - The **link secret** (32 random bytes) and, in an invite session, the
 *   out-of-band **code** key both codes: AES-256-GCM under
 *   HKDF-SHA256(secret, salt = code, info = purpose). Whoever holds only the
 *   link cannot read or write an invite session's codes.
 * - The **owner key** — an ECDSA P-256 key minted per session, its public
 *   half in the link — signs every reply code, so a person holding the link
 *   cannot pose as the owner to another joiner.
 *
 * Every seal binds its context as additional data (the purpose, the owner
 * key, and for a reply the request it answers), so a code cannot be replayed
 * in another place.
 */

const LABEL = "osm-live-v1";
/** The code alphabet ADR 0044 codes use: no vowels, no look-alikes. */
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const IV_BYTES = 12;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGNING = { name: "ECDSA", hash: "SHA-256" } as const;
const encoder = new TextEncoder();

export function toB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromB64url(raw: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(raw)) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1)
      bytes[at] = binary.charCodeAt(at);
    return bytes;
  } catch {
    return null;
  }
}

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

export type Purpose = "request" | "reply";

export type SealContext = Readonly<{
  /** The link secret, base64url. */
  secret: string;
  /** The normalized code in an invite session; null in an open one. */
  code: string | null;
  purpose: Purpose;
  /** What the seal is bound to: the owner key, and a reply's request id. */
  bound: readonly string[];
}>;

async function sealKey(context: SealContext): Promise<CryptoKey | null> {
  const secret = fromB64url(context.secret);
  if (!secret || secret.length !== 32) return null;
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
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

export type OwnerKey = Readonly<{
  /** The public key, raw uncompressed P-256 point, base64url (87 chars). */
  pub: string;
  sign: (data: string) => Promise<string>;
}>;

/** A fresh signing key for one session; its private half never leaves. */
export async function newOwnerKey(): Promise<OwnerKey> {
  const pair = await crypto.subtle.generateKey(ECDSA, false, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    pub: toB64url(raw),
    sign: async (data) =>
      toB64url(
        new Uint8Array(
          await crypto.subtle.sign(
            SIGNING,
            pair.privateKey,
            encoder.encode(data),
          ),
        ),
      ),
  };
}

/** Whether `signature` is the owner's over `data`. */
export async function verifyOwner(
  pub: string,
  data: string,
  signature: string,
): Promise<boolean> {
  const raw = fromB64url(pub);
  const sig = fromB64url(signature);
  if (!raw || raw.length !== 65 || !sig || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", raw, ECDSA, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(SIGNING, key, sig, encoder.encode(data));
  } catch {
    return false;
  }
}
