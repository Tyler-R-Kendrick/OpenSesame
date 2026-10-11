/**
 * The recipient's side of a recovery (ADR 0187): make a request with a fresh
 * key of its own, hand it to the guardians, and — once the ledger holds enough
 * releases — open them, recombine the recovery secret and open the bundle.
 *
 * The recipient's X25519 key is made for the request and is what the request
 * names. A release is sealed to it and to nothing else, so the people who
 * relay packets between the guardians and the recipient learn nothing.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { RELEASE_HPKE_INFO, releaseAad } from "./approve.js";
import { fromB64url, toB64url, utf8Bytes, utf8Text, wipe } from "./bytes.js";
import type { Json } from "./canonical.js";
import { MAX_RECOVERY_EXPONENT, openBundle } from "./circle.js";
import { type HpkeKeyPair, generateKeyPair, openBase } from "./hpke.js";
import type { QuorumLedger } from "./ledger.js";
import { createRequest } from "./request.js";
import { combineMnemonics } from "./slip39/index.js";
import type { QuorumRequest, Release, SignedPolicy } from "./types.js";
import { shareCommitment } from "./wrap.js";

export class RecoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Guardians whose release was dropped and who can release again. */
    readonly guardianIds: readonly string[] = [],
  ) {
    super(message);
    this.name = "RecoveryError";
  }
}

export type PendingRecovery = Readonly<{
  request: QuorumRequest;
  /** Keep it for the life of the request and nowhere else. */
  recipient: HpkeKeyPair;
}>;

/** Raise a request to recover the circle's collection to a key made now. */
export function startRecovery(input: {
  signedPolicy: SignedPolicy;
  recipientLabel: string;
  now: Date;
}): PendingRecovery {
  const recipient = generateKeyPair();
  const request = createRequest({
    signedPolicy: input.signedPolicy,
    operation: "recover-collection",
    recipientPublicKey: toB64url(recipient.publicKey),
    recipientLabel: input.recipientLabel,
    now: input.now,
  });
  return { request, recipient };
}

/** One released share, opened and checked against the owner's commitment. */
export function openRelease(
  release: Release,
  recipientSecretKey: Uint8Array,
  signed: SignedPolicy,
): string {
  const { policy } = signed;
  let mnemonic: string;
  try {
    mnemonic = utf8Text(
      openBase({
        recipientSecretKey,
        enc: fromB64url(release.sealed.enc),
        info: utf8Bytes(RELEASE_HPKE_INFO),
        aad: releaseAad(release.requestDigest, release.guardianId),
        ciphertext: fromB64url(release.sealed.ciphertext),
      }),
    );
  } catch {
    throw new RecoveryError(
      "open",
      `${release.guardianId}'s release did not open`,
    );
  }
  const expected = policy.shareCommitments[release.guardianId];
  if (
    shareCommitment(policy.circleId, release.guardianId, mnemonic) !== expected
  ) {
    throw new RecoveryError(
      "commitment",
      `${release.guardianId}'s share is not the one the owner committed to`,
    );
  }
  return mnemonic;
}

type Opened = Readonly<{ mnemonics: string[]; bad: Release[] }>;

function openChosen(
  chosen: readonly Release[],
  recipientSecretKey: Uint8Array,
  signed: SignedPolicy,
): Opened {
  const mnemonics: string[] = [];
  const bad: Release[] = [];
  for (const release of chosen) {
    try {
      mnemonics.push(openRelease(release, recipientSecretKey, signed));
    } catch (error) {
      if (!(error instanceof RecoveryError)) throw error;
      bad.push(release);
    }
  }
  return { mnemonics, bad };
}

/**
 * Recombine and open. A release that does not open, or is not the share the
 * owner committed to, is dropped from the ledger so that guardian can release
 * again; the next combinable set is tried from the releases already in hand.
 * Only when no combinable set of good shares is left does this throw, naming
 * the guardians to ask again (`RecoveryError.guardianIds`).
 *
 * A signature cannot cover the sealed share (it is made after the touch), so
 * anyone relaying a release can damage it. Dropping the bad one, rather than
 * keeping the guardian's one slot burnt, is what stops that from being a way
 * to stall a recovery.
 */
export async function completeRecovery(input: {
  ledger: QuorumLedger;
  recipientSecretKey: Uint8Array;
  bundle: BoundaryValue;
}): Promise<Json> {
  const dropped: string[] = [];
  // Each pass drops at least one release or returns, so a guardian-count of
  // passes is the most there can be; the bound only guards against a ledger
  // that does not forget what it is told to.
  const passes = input.ledger.signedPolicy.policy.guardians.length + 1;
  for (let pass = 0; pass < passes; pass += 1) {
    const chosen = input.ledger.selectForCombine();
    if (!chosen) {
      throw new RecoveryError(
        dropped.length > 0 ? "bad_release" : "not_ready",
        dropped.length > 0
          ? "a release did not open as the share the owner committed to; ask those guardians again"
          : "not enough shares have been released",
        dropped,
      );
    }
    const { mnemonics, bad } = openChosen(
      chosen,
      input.recipientSecretKey,
      input.ledger.signedPolicy,
    );
    if (bad.length === 0) {
      const secret = await combineMnemonics(mnemonics, {
        maxIterationExponent: MAX_RECOVERY_EXPONENT,
      });
      try {
        return openBundle(input.bundle, secret);
      } finally {
        wipe(secret);
      }
    }
    for (const release of bad) {
      input.ledger.discardRelease(release.guardianId);
      dropped.push(release.guardianId);
    }
  }
  throw new RecoveryError(
    "bad_release",
    "releases kept failing to open; ask those guardians again",
    dropped,
  );
}
