/**
 * Proving a joiner holds the link — and, in an invite session, the code
 * (ADR 0148 §3).
 *
 * The key is HKDF-SHA256 over the link secret, salted with the code (empty
 * in an open session), and the proof is an HMAC over both parties' session
 * keys, so it cannot be replayed for another joiner or another session. The
 * owner checks it with `crypto.subtle.verify`, which compares in constant
 * time, and counts every miss toward ending the session.
 */

const INFO = new TextEncoder().encode("osm-live-v1 join");
const LABEL = "osm-live-v1";

/** The code alphabet ADR 0044 codes use: no vowels, no look-alikes. */
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";

function fromB64url(raw: string): Uint8Array<ArrayBuffer> {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1)
    bytes[at] = binary.charCodeAt(at);
  return bytes;
}

export function toB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let at = 0; at < bytes.length; at += 1)
    bytes[at] = Number.parseInt(hex.slice(at * 2, at * 2 + 2), 16);
  return bytes;
}

/** A fresh link secret: 32 random bytes, base64url. */
export function newLinkSecret(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(32)));
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

async function proofKey(
  secret: string,
  code: string | null,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    fromB64url(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(code ?? ""),
      info: INFO,
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

function transcript(owner: string, joiner: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${LABEL}|${owner}|${joiner}`);
}

export type ProofInput = Readonly<{
  /** The link secret, base64url. */
  secret: string;
  /** The owner's session key, hex. */
  owner: string;
  /** The joiner's session key, hex. */
  joiner: string;
  /** The normalized code in an invite session; null in an open one. */
  code: string | null;
}>;

/** The joiner's proof, hex. */
export async function joinProof(input: ProofInput): Promise<string> {
  const key = await proofKey(input.secret, input.code);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    transcript(input.owner, input.joiner),
  );
  return toHex(new Uint8Array(mac));
}

/** Whether `proof` is right for this joiner — compared in constant time. */
export async function checkJoinProof(
  input: ProofInput,
  proof: string,
): Promise<boolean> {
  const mac = fromHex(proof);
  if (!mac || mac.length !== 32) return false;
  const key = await proofKey(input.secret, input.code);
  return crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    transcript(input.owner, input.joiner),
  );
}
