/**
 * A guardian's share, wrapped under their own key.
 *
 * The pattern is Yubico's PRF -> HKDF -> encryption key: the authenticator
 * returns a secret only its holder can reproduce, HKDF turns that into a key
 * for this circle, this guardian, this credential and this epoch, and an AEAD
 * seals the share under it. Each credential of a guardian wraps the same
 * share separately, so a backup key restores availability and is never a
 * second vote.
 *
 * What this protects, and what it does not: the share is encrypted at rest
 * under hardware-derived material. It is decrypted in the guardian's browser
 * while released — the PRF output is returned to the page — so a compromised
 * guardian device during a release can see that one share (ADR 0187).
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { z } from "zod";
import {
  fromB64url,
  randomBytes,
  toB64url,
  utf8Bytes,
  utf8Text,
  wipe,
} from "./bytes.js";
import { frame, framedDigest } from "./canonical.js";

const PRF_PURPOSE = "opensesame:quorum-prf:v1";
const WRAP_SALT = "opensesame:quorum-wrap-salt:v1";
const WRAP_INFO = "opensesame:quorum-wrap:v1";
const WRAP_AAD = "opensesame:quorum-wrap-aad:v1";
const COMMITMENT = "opensesame:quorum-share-commitment:v1";
const MIN_PRF_BYTES = 32;

export class WrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrapError";
  }
}

export type WrapContext = Readonly<{
  circleId: string;
  guardianId: string;
  credentialId: string;
  epoch: number;
}>;

/**
 * The input the browser hashes into the PRF salt. Public and fixed per circle
 * and guardian: a PRF salt is not a secret, the credential is.
 */
export function prfInput(circleId: string, guardianId: string): Uint8Array {
  return frame([PRF_PURPOSE, circleId, guardianId]);
}

function normalize(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
}

/** What the signed policy commits to for a guardian's share. */
export function shareCommitment(
  circleId: string,
  guardianId: string,
  mnemonic: string,
): string {
  return framedDigest(COMMITMENT, [circleId, guardianId, normalize(mnemonic)]);
}

function wrapKey(output: Uint8Array, ctx: WrapContext): Uint8Array {
  if (output.length < MIN_PRF_BYTES) {
    throw new WrapError("a PRF output is at least 32 bytes");
  }
  return hkdf(
    sha256,
    output,
    sha256(frame([WRAP_SALT, ctx.circleId])),
    frame([
      WRAP_INFO,
      ctx.circleId,
      ctx.guardianId,
      ctx.credentialId,
      String(ctx.epoch),
    ]),
    32,
  );
}

function wrapAad(ctx: WrapContext): Uint8Array {
  return frame([
    WRAP_AAD,
    ctx.circleId,
    ctx.guardianId,
    ctx.credentialId,
    String(ctx.epoch),
  ]);
}

export const ShareEnvelopeSchema = z
  .object({
    credentialId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]+$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type ShareEnvelope = z.infer<typeof ShareEnvelopeSchema>;

/** One guardian's share, wrapped once per credential that can unwrap it. */
export const WrappedShareSchema = z
  .object({
    v: z.literal(1),
    circleId: z.string(),
    guardianId: z.string(),
    epoch: z.number().int().min(1),
    policyDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    envelopes: z.array(ShareEnvelopeSchema).min(1).max(8),
  })
  .strict();
export type WrappedShare = z.infer<typeof WrappedShareSchema>;

export function wrapShare(
  mnemonic: string,
  ctx: WrapContext,
  output: Uint8Array,
): ShareEnvelope {
  const key = wrapKey(output, ctx);
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(key, nonce, wrapAad(ctx)).encrypt(
    utf8Bytes(normalize(mnemonic)),
  );
  wipe(key);
  return {
    credentialId: ctx.credentialId,
    nonce: toB64url(nonce),
    ciphertext: toB64url(sealed),
  };
}

/** The mnemonic, or a `WrapError` if the output, the context or the bytes are wrong. */
export function unwrapShare(
  envelope: ShareEnvelope,
  ctx: WrapContext,
  output: Uint8Array,
): string {
  if (envelope.credentialId !== ctx.credentialId) {
    throw new WrapError("this envelope belongs to another credential");
  }
  const key = wrapKey(output, ctx);
  try {
    const opened = xchacha20poly1305(
      key,
      fromB64url(envelope.nonce),
      wrapAad(ctx),
    ).decrypt(fromB64url(envelope.ciphertext));
    return utf8Text(opened);
  } catch {
    throw new WrapError(
      "the share did not unwrap: wrong key, circle, guardian or epoch",
    );
  } finally {
    wipe(key);
  }
}
