/**
 * Portable secret drops for Pages with no backend, Host or daemon. The sealed
 * manifest and its expiry travel in the URL fragment. Both the bearer and
 * separate user code are required to decrypt the manifest; the separate drop
 * key then opens its payload. The fragment is never sent to a server.
 *
 * Without a server, one-time use and revocation cannot be enforced after a
 * link is shared. Wrong-code lockout is only for this recipient's tab. Expiry
 * is checked from the timestamp bound to the code-encrypted manifest. The
 * generated code has 80 bits of entropy; 600k PBKDF2 rounds slow offline
 * guesses but local lockout cannot prevent them. Legacy `ospd1` links must be
 * recreated: that format exposed the manifest to anyone holding the link.
 */

import { dropRefusal } from "@opensesame/ceremony-kit";
import type { JsonObject } from "@opensesame/os-domain";
import { bytesToB64url } from "@opensesame/vault-core";
import {
  clearPortableDropWrongAttempts,
  portableDropWrongAttempts,
  recordPortableDropWrongAttempt,
  resetPortableDropAttemptsForTests,
} from "./portable-drop-attempts.js";
import {
  PORTABLE_DROP_TOKEN_PREFIX,
  PortableDropFailure,
  decodePortableDropPacket,
  isPortableDropToken,
  openPortableDropManifest,
  sealPortableDropPacket,
} from "./portable-drop-crypto.js";

export {
  PortableDropFailure,
  PORTABLE_DROP_TOKEN_PREFIX,
  isPortableDropToken,
  resetPortableDropAttemptsForTests,
};

/** Same ceiling as the device-local claim store. */
const MAX_PORTABLE_ATTEMPTS = 5;
const LOCKOUT_WORDS =
  "Locked out. Too many wrong codes — ask the sender for a fresh drop.";

function wrongCodeWords(triesLeft: number): string {
  const base = "That code does not match this drop.";
  if (triesLeft > 1) return `${base} ${triesLeft} tries left.`;
  if (triesLeft === 1) return `${base} This is your last try.`;
  return `${base} No tries left.`;
}

/** Uniform index in [0, max) without modulo bias (rejection sampling). */
function randomIndex(max: number): number {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error("randomIndex needs a positive bound");
  }
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  const view = new DataView(buf.buffer);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = view.getUint32(0);
  } while (value >= limit);
  return value % max;
}

function mintUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 16; i += 1) {
    out += alphabet[randomIndex(alphabet.length)] ?? "A";
    if (i % 4 === 3 && i < 15) out += "-";
  }
  return out;
}

export type PortableDropBundle = {
  claimId: string;
  bearerToken: string;
  pkt: string;
  expiresAtMs: number;
};

export type PortableDropSession = {
  claimId: string;
  bearerToken: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: string;
  pkt: string;
};

export async function buildPortableDropBundle(
  manifest: JsonObject,
  ttlMs: number,
  userCode: string,
): Promise<PortableDropBundle> {
  const claimId = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
  const secret = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const bearerToken = `${PORTABLE_DROP_TOKEN_PREFIX}${claimId}.${secret}`;
  const expiresAtMs = Date.now() + Math.max(1_000, ttlMs);
  const pkt = await sealPortableDropPacket({
    bearerToken,
    manifest,
    expiresAtMs,
    userCode,
  });
  return { claimId, bearerToken, pkt, expiresAtMs };
}

function lockedOut(): PortableDropFailure {
  return new PortableDropFailure("locked_out", LOCKOUT_WORDS);
}

export async function openPortableDropBundle(
  pkt: string,
  bearerToken: string,
  userCode: string,
): Promise<JsonObject> {
  if (!pkt) {
    throw new PortableDropFailure(
      "invalid_token",
      dropRefusal("invalid_token", 401).words,
    );
  }
  const decoded = await decodePortableDropPacket(pkt, bearerToken);
  if (decoded.expiresAtMs <= Date.now()) {
    throw new PortableDropFailure("expired", dropRefusal("EXPIRED", 410).words);
  }
  if (portableDropWrongAttempts(decoded.claimId) >= MAX_PORTABLE_ATTEMPTS) {
    throw lockedOut();
  }
  const manifest = await openPortableDropManifest(decoded, userCode);
  if (manifest === null) {
    const attempts = recordPortableDropWrongAttempt(decoded.claimId);
    const attemptsLeft = MAX_PORTABLE_ATTEMPTS - attempts;
    if (attemptsLeft <= 0) throw lockedOut();
    throw new PortableDropFailure(
      "invalid_code",
      wrongCodeWords(attemptsLeft),
      attemptsLeft,
    );
  }
  clearPortableDropWrongAttempts(decoded.claimId);
  return manifest;
}

export async function createPortableDropSession(
  manifest: JsonObject,
  ttlMs: number,
  verifyUrl: string,
): Promise<PortableDropSession> {
  const userCode = mintUserCode();
  const bundle = await buildPortableDropBundle(manifest, ttlMs, userCode);
  return {
    claimId: bundle.claimId,
    bearerToken: bundle.bearerToken,
    userCode,
    verifyUrl,
    expiresAt: new Date(bundle.expiresAtMs).toISOString(),
    pkt: bundle.pkt,
  };
}

export function portableDropLink(
  verifyUrl: string,
  bearerToken: string,
  fragmentKey: string,
  pkt: string,
): string {
  const token = encodeURIComponent(bearerToken);
  const key = encodeURIComponent(fragmentKey);
  const packet = encodeURIComponent(pkt);
  return `${verifyUrl}#token=${token}&key=${key}&pkt=${packet}`;
}
