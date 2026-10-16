/**
 * Portable secret drops for Pages with no backend, Host or daemon. The sealed
 * manifest, its expiry and the user-code verifier travel in the URL fragment;
 * the bearer secret derives the transport key and the separate drop key still
 * decrypts the manifest. The fragment is never sent to a server.
 *
 * Without a server, one-time use and revocation cannot be enforced after a
 * link is shared. Wrong-code lockout is only for this recipient's tab. Expiry
 * is checked from the authenticated timestamp inside the sealed packet.
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
  portableDropCodeMatches,
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

function mintUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    // SAFETY: bytes[i] is defined for i < length.
    const b = bytes[i] ?? 0;
    out += alphabet[b % alphabet.length] ?? "A";
    if (i === 3) out += "-";
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
  if (!(await portableDropCodeMatches(decoded, userCode))) {
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
  return decoded.manifest;
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
