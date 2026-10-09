import { type JsonObject, overlapCast } from "@opensesame/os-domain";

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Cryptographically strong jti — never Math.random. */
function randomJti(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return b64url(bytes);
  }
  throw new Error("crypto_unavailable_for_dpop_jti");
}

async function getSubtle(): Promise<SubtleCrypto> {
  // Prefer Web Crypto (browsers + Node 19+). Avoid new Function / eval for node:crypto
  // fallback — that trips structural SAST and is unnecessary once subtle is global.
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return subtle;
  throw new Error("crypto_subtle_unavailable");
}

/**
 * RFC 9449 §4.3 `ath`: the hash of the access token the proof travels with.
 *
 * Without it a proof is bound to a key and a request but not to a token, so a
 * proof observed alongside one token can be replayed alongside another. The
 * verifier in `crates/proof` requires it whenever a token is present, so a proof
 * minted without it was never going to be accepted either.
 */
export async function accessTokenHash(accessToken: string): Promise<string> {
  const subtle = await getSubtle();
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(accessToken),
  );
  return b64url(digest);
}

/** Create an in-memory ES256 keypair and DPoP proof factory. */
export async function createDpopKeyPair() {
  const subtle = await getSubtle();
  const keyPair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const jwk = overlapCast(await subtle.exportKey("jwk", keyPair.publicKey));
  // Explicit reads (not destructuring): the extension bundler targets firefox78,
  // where esbuild refuses to transform this destructuring pattern.
  const kty = jwk.kty;
  const crv = jwk.crv;
  const x = jwk.x;
  const y = jwk.y;

  async function createDpopProof(
    htu: string,
    htm: string,
    accessToken?: string,
    nonce?: string,
  ): Promise<string> {
    const header = {
      alg: "ES256",
      typ: "dpop+jwt",
      jwk: { kty, crv, x, y },
    };
    const payload: JsonObject = {
      iat: Math.floor(Date.now() / 1000),
      jti: randomJti(),
      // A query string is not part of the bound URI (RFC 9449 §4.2).
      htu: htuFor(htu),
      htm: htm.toUpperCase(),
    };
    if (accessToken) {
      payload.ath = await accessTokenHash(accessToken);
    }
    // RFC 9449 §8: a server may require its own nonce so it, not the client,
    // decides how fresh a proof is.
    if (nonce) {
      payload.nonce = nonce;
    }
    const enc = new TextEncoder();
    const h = b64url(enc.encode(JSON.stringify(header)));
    const p = b64url(enc.encode(JSON.stringify(payload)));
    const data = enc.encode(`${h}.${p}`);
    const sig = await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      data,
    );
    return `${h}.${p}.${b64url(sig)}`;
  }

  return { createDpopProof, jwk: { kty, crv, x, y } };
}

/** The bound URI: scheme, authority and path, without query or fragment. */
function htuFor(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}
