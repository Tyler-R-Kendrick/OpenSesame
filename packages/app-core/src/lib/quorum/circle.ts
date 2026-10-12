/**
 * The owner's side of creating a circle (ADR 0187).
 *
 * One call turns guardians who have enrolled and a payload the owner wants to
 * survive them into:
 * - a signed policy, which commits to each guardian's share;
 * - a recovery bundle: the payload encrypted under a key only the recovery
 *   secret derives, plus the signed policy, safe to store anywhere;
 * - one sealed delivery per guardian: their share, as a SLIP-0039 mnemonic,
 *   encrypted to the receiving key they made at enrollment.
 *
 * The recovery secret exists in this function and nowhere after it. Any
 * SLIP-0039 tool can recombine the mnemonics, with the empty passphrase this
 * writes — the exit door if OpenSesame is not there to recover with.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  fromB64url,
  randomBytes,
  toB64url,
  utf8Bytes,
  utf8Text,
  wipe,
} from "./bytes.js";
import { type Json, frame } from "./canonical.js";
import { sealBase } from "./hpke.js";
import { signPolicy, verifySignedPolicy } from "./policy.js";
import { generateMnemonics } from "./slip39/index.js";
import {
  type CirclePolicy,
  type Group,
  type Guardian,
  type Operation,
  type SignedPolicy,
  SignedPolicySchema,
} from "./types.js";
import { shareCommitment } from "./wrap.js";

const DELIVERY_INFO = "opensesame:quorum-delivery:v1";
const COLLECTION_SALT = "opensesame:quorum-collection-salt:v1";
const COLLECTION_INFO = "opensesame:quorum-collection:v1";
const COLLECTION_AAD = "opensesame:quorum-collection-aad:v1";
/** SLIP-0039's reference default: 20 000 PBKDF2 iterations over the four rounds. */
const ITERATION_EXPONENT = 1;
/** What a bundle will make a recipient spend recombining: 10 000 x 2^6 iterations. */
export const MAX_RECOVERY_EXPONENT = 6;

export type OwnerKeys = Readonly<{ publicKey: string; secretKey: Uint8Array }>;

export function generateOwnerKeys(): OwnerKeys {
  const secretKey = ed25519.utils.randomSecretKey();
  return { publicKey: toB64url(ed25519.getPublicKey(secretKey)), secretKey };
}

export type CircleDraft = Readonly<{
  circleId: string;
  label: string;
  collection: string;
  rpId: string;
  origins: readonly string[];
  guardians: readonly Guardian[];
  groups: readonly Group[];
  groupThreshold: number;
  operations: readonly Operation[];
  approvalWindowSec: number;
  releaseDelaySec: number;
  requestLifetimeSec: number;
  requireUserVerification: boolean;
}>;

export const RecoveryBundleSchema = z
  .object({
    v: z.literal(1),
    signedPolicy: SignedPolicySchema,
    nonce: z.string().regex(/^[A-Za-z0-9_-]+$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type RecoveryBundle = z.infer<typeof RecoveryBundleSchema>;

export const ShareDeliverySchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("share-delivery"),
    circleId: z.string(),
    guardianId: z.string(),
    epoch: z.number().int().min(1),
    enc: z.string().regex(/^[A-Za-z0-9_-]+$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type ShareDelivery = z.infer<typeof ShareDeliverySchema>;

export function deliveryAad(
  circleId: string,
  guardianId: string,
  epoch: number,
) {
  return frame([DELIVERY_INFO, circleId, guardianId, String(epoch)]);
}

function collectionKey(secret: Uint8Array, circleId: string, epoch: number) {
  return hkdf(
    sha256,
    secret,
    sha256(frame([COLLECTION_SALT, circleId])),
    frame([COLLECTION_INFO, circleId, String(epoch)]),
    32,
  );
}

function collectionAad(policy: SignedPolicy): Uint8Array {
  return frame([
    COLLECTION_AAD,
    policy.digest,
    policy.policy.circleId,
    String(policy.policy.epoch),
  ]);
}

/** Encrypt the payload under the recovery secret's collection key. */
export function sealBundle(
  signedPolicy: SignedPolicy,
  recoverySecret: Uint8Array,
  payload: Json,
): RecoveryBundle {
  const { circleId, epoch } = signedPolicy.policy;
  const key = collectionKey(recoverySecret, circleId, epoch);
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(
    key,
    nonce,
    collectionAad(signedPolicy),
  ).encrypt(utf8Bytes(JSON.stringify(payload)));
  wipe(key);
  return {
    v: 1,
    signedPolicy,
    nonce: toB64url(nonce),
    ciphertext: toB64url(sealed),
  };
}

/** The payload, once the recovery secret is recombined. Refuses a bundle whose policy is not the owner's. */
export function openBundle(
  input: BoundaryValue,
  recoverySecret: Uint8Array,
): Json {
  const bundle = RecoveryBundleSchema.parse(input);
  const signed = verifySignedPolicy(bundle.signedPolicy);
  const { circleId, epoch } = signed.policy;
  const key = collectionKey(recoverySecret, circleId, epoch);
  try {
    const opened = xchacha20poly1305(
      key,
      fromB64url(bundle.nonce),
      collectionAad(signed),
    ).decrypt(fromB64url(bundle.ciphertext));
    return JSON.parse(utf8Text(opened));
  } catch {
    throw new Error("the recovery secret does not open this bundle");
  } finally {
    wipe(key);
  }
}

export type CreatedCircle = Readonly<{
  signedPolicy: SignedPolicy;
  /** `null` for a circle that only authorizes actions: it holds no secret. */
  bundle: RecoveryBundle | null;
  deliveries: readonly ShareDelivery[];
}>;

function seatShares(draft: CircleDraft, mnemonics: string[][]) {
  const shares = new Map<string, string>();
  draft.groups.forEach((group, g) => {
    group.guardianIds.forEach((guardianId, m) => {
      const mnemonic = mnemonics[g]?.[m];
      if (!mnemonic) throw new Error("a share is missing");
      shares.set(guardianId, mnemonic);
    });
  });
  return shares;
}

/** Where a policy sits in a circle's history: epoch 1, or the one it replaces. */
export type Succession = Readonly<{
  epoch: number;
  supersedes?: Readonly<{ epoch: number; digest: string }>;
}>;

function basePolicy(
  draft: CircleDraft,
  owner: OwnerKeys,
  now: Date,
  shareCommitments: Readonly<Record<string, string>>,
  succession: Succession,
): CirclePolicy {
  const policy: CirclePolicy = {
    v: 1,
    circleId: draft.circleId,
    epoch: succession.epoch,
    label: draft.label,
    collection: draft.collection,
    rpId: draft.rpId,
    origins: [...draft.origins],
    ownerKey: owner.publicKey,
    groupThreshold: draft.groupThreshold,
    groups: [...draft.groups],
    guardians: [...draft.guardians],
    shareCommitments,
    operations: [...draft.operations],
    approvalWindowSec: draft.approvalWindowSec,
    releaseDelaySec: draft.releaseDelaySec,
    requestLifetimeSec: draft.requestLifetimeSec,
    requireUserVerification: draft.requireUserVerification,
    createdAt: now.toISOString(),
  };
  if (succession.supersedes) policy.supersedes = { ...succession.supersedes };
  return policy;
}

export type CircleInput = Readonly<{
  draft: CircleDraft;
  owner: OwnerKeys;
  payload?: Json;
  now: Date;
}>;

/**
 * A circle with shares (it governs `recover-collection`) or without (it only
 * approves actions). The first needs a payload to protect; the second has none.
 */
export function createCircle(input: CircleInput): Promise<CreatedCircle> {
  return assembleCircle({ ...input, succession: { epoch: 1 } });
}

/**
 * The one assembly of a policy, its bundle and its deliveries, for a first
 * epoch and for each one after (`epoch.ts`). Every call draws a fresh
 * recovery secret, so a later epoch's shares open nothing of an earlier one.
 */
export async function assembleCircle(
  input: CircleInput & Readonly<{ succession: Succession }>,
): Promise<CreatedCircle> {
  const { draft, owner, succession } = input;
  if (!draft.operations.includes("recover-collection")) {
    const signedPolicy = signPolicy(
      basePolicy(draft, owner, input.now, {}, succession),
      owner.secretKey,
    );
    return { signedPolicy, bundle: null, deliveries: [] };
  }
  if (input.payload === undefined) {
    throw new Error(
      "a circle that recovers a collection needs a payload to protect",
    );
  }
  const payload = input.payload;
  const recoverySecret = randomBytes(32);
  try {
    const mnemonics = await generateMnemonics({
      groupThreshold: draft.groupThreshold,
      groups: draft.groups.map((g) => [g.threshold, g.guardianIds.length]),
      masterSecret: recoverySecret,
      iterationExponent: ITERATION_EXPONENT,
    });
    const shares = seatShares(draft, mnemonics);
    const policy = basePolicy(
      draft,
      owner,
      input.now,
      Object.fromEntries(
        [...shares].map(([id, m]) => [
          id,
          shareCommitment(draft.circleId, id, m),
        ]),
      ),
      succession,
    );
    const signedPolicy = signPolicy(policy, owner.secretKey);
    const deliveries = draft.guardians.map((guardian) => {
      const mnemonic = shares.get(guardian.id) ?? "";
      const sealed = sealBase({
        recipientPublicKey: fromB64url(guardian.hpkePublicKey),
        info: utf8Bytes(DELIVERY_INFO),
        aad: deliveryAad(draft.circleId, guardian.id, policy.epoch),
        plaintext: utf8Bytes(mnemonic),
      });
      return {
        v: 1 as const,
        kind: "share-delivery" as const,
        circleId: draft.circleId,
        guardianId: guardian.id,
        epoch: policy.epoch,
        enc: toB64url(sealed.enc),
        ciphertext: toB64url(sealed.ciphertext),
      };
    });
    return {
      signedPolicy,
      bundle: sealBundle(signedPolicy, recoverySecret, payload),
      deliveries,
    };
  } finally {
    wipe(recoverySecret);
  }
}
