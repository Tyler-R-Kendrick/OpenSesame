/**
 * Becoming a guardian is consent, not assignment. The owner sends an invite;
 * the guardian's device makes an X25519 key to receive a share, registers one
 * or more keys of their own, and signs the lot with each key. The owner
 * verifies those signatures before the guardian goes into the policy, so a
 * guardian entry is always one whose keys answered.
 *
 * A guardian registers a backup key here too. It is a second way to be the
 * same guardian: it unwraps the same share and casts no second vote.
 */

import { sha256 } from "@noble/hashes/sha2";
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { fromB64url, randomBytes, toB64url, wipe } from "./bytes.js";
import { frame } from "./canonical.js";
import type { Ceremony, Registered } from "./ceremony.js";
import { generateKeyPair } from "./hpke.js";
import {
  AlgSchema,
  AssertionProofSchema,
  type Guardian,
  type GuardianCredential,
} from "./types.js";
import { AssertionError, verifyAssertion } from "./webauthn.js";
import { prfInput } from "./wrap.js";

const ENROLL_PURPOSE = "opensesame:quorum-enroll:v1";
const INVITE_TTL_SEC = 7 * 86400;

const B64URL = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(8192);
const ISO = z.string().datetime({ offset: true });
const ID = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

export const InviteSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("invite"),
    inviteId: B64URL,
    circleId: ID,
    label: z.string().min(1).max(120),
    rpId: z.string().min(1).max(253),
    origins: z.array(z.string().url()).min(1).max(8),
    /** The owner's Ed25519 key. A guardian pins it; later policies must match. */
    ownerKey: B64URL,
    requireUserVerification: z.boolean(),
    createdAt: ISO,
    expiresAt: ISO,
  })
  .strict();
export type Invite = z.infer<typeof InviteSchema>;

const EnrolledCredentialSchema = z
  .object({
    credentialId: B64URL,
    publicKey: B64URL,
    alg: AlgSchema,
    label: z.string().min(1).max(120),
    prf: z.boolean(),
    proof: AssertionProofSchema,
  })
  .strict();

export const EnrollmentSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("enrollment"),
    inviteId: B64URL,
    guardianId: ID,
    name: z.string().min(1).max(120),
    hpkePublicKey: B64URL,
    credentials: z.array(EnrolledCredentialSchema).min(1).max(8),
  })
  .strict();
export type Enrollment = z.infer<typeof EnrollmentSchema>;

export class EnrollmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EnrollmentError";
  }
}

export function newCircleId(): string {
  return `c-${toB64url(randomBytes(9))}`;
}

export function createInvite(input: {
  circleId: string;
  label: string;
  rpId: string;
  origins: readonly string[];
  ownerKey: string;
  requireUserVerification: boolean;
  now: Date;
}): Invite {
  return InviteSchema.parse({
    v: 1,
    kind: "invite",
    inviteId: toB64url(randomBytes(16)),
    circleId: input.circleId,
    label: input.label,
    rpId: input.rpId,
    origins: [...input.origins],
    ownerKey: input.ownerKey,
    requireUserVerification: input.requireUserVerification,
    createdAt: input.now.toISOString(),
    expiresAt: new Date(
      input.now.getTime() + INVITE_TTL_SEC * 1000,
    ).toISOString(),
  });
}

/** What every key of one guardian signs: the invite, the guardian, the receiving key, the keys. */
export function enrollmentChallenge(
  invite: Pick<Invite, "inviteId" | "circleId">,
  guardianId: string,
  hpkePublicKey: string,
  credentialIds: readonly string[],
): Uint8Array {
  return sha256(
    frame([
      ENROLL_PURPOSE,
      invite.inviteId,
      invite.circleId,
      guardianId,
      hpkePublicKey,
      ...[...credentialIds].sort(),
    ]),
  );
}

export type GuardianSecrets = Readonly<{
  /** Opens the share the owner sends. Keep it sealed in the guardian's vault. */
  hpkeSecretKey: Uint8Array;
}>;

/** What a guardian's device ends an enrollment with: the answer to send, and the key to keep. */
export type EnrolledGuardian = Readonly<{
  enrollment: Enrollment;
  secrets: GuardianSecrets;
}>;

export async function enrollGuardian(input: {
  invite: Invite;
  /** The origin this page is on; it must be one the circle accepts. */
  currentOrigin: string;
  name: string;
  keyLabels: readonly string[];
  ceremony: Ceremony;
  guardianId?: string;
}): Promise<EnrolledGuardian> {
  const { invite } = input;
  if (!invite.origins.includes(input.currentOrigin)) {
    throw new EnrollmentError(
      "origin",
      "open this invite at one of the circle's origins",
    );
  }
  const guardianId = input.guardianId ?? `g-${toB64url(randomBytes(9))}`;
  const hpke = generateKeyPair();
  const hpkePublicKey = toB64url(hpke.publicKey);
  const registered: (Registered & { label: string })[] = [];
  for (const label of input.keyLabels) {
    const key = await input.ceremony.register({
      rpId: invite.rpId,
      rpName: "OpenSesame",
      userId: randomBytes(16),
      userName: input.name,
      challenge: randomBytes(32),
      prfInput: prfInput(invite.circleId, guardianId),
      excludeCredentialIds: registered.map((r) => r.credentialId),
      requireUserVerification: invite.requireUserVerification,
    });
    registered.push({ ...key, label });
  }
  const challenge = enrollmentChallenge(
    invite,
    guardianId,
    hpkePublicKey,
    registered.map((r) => r.credentialId),
  );
  const credentials: Enrollment["credentials"] = [];
  for (const key of registered) {
    const asserted = await input.ceremony.assert({
      rpId: invite.rpId,
      challenge,
      allowCredentialIds: [key.credentialId],
      requireUserVerification: invite.requireUserVerification,
      prfInput: prfInput(invite.circleId, guardianId),
      // A key without PRF can still approve; the policy decides whether that is enough.
      prfOptional: true,
    });
    // The extension answered for this key. Whether the answer is stable is
    // proved later, by unwrapping a share.
    const prf = asserted.prfOutput !== null;
    if (asserted.prfOutput) wipe(asserted.prfOutput);
    credentials.push({
      credentialId: key.credentialId,
      publicKey: key.publicKey,
      alg: key.alg,
      label: key.label,
      prf,
      proof: asserted.proof,
    });
  }
  return {
    enrollment: EnrollmentSchema.parse({
      v: 1,
      kind: "enrollment",
      inviteId: invite.inviteId,
      guardianId,
      name: input.name,
      hpkePublicKey,
      credentials,
    }),
    secrets: { hpkeSecretKey: hpke.secretKey },
  };
}

/**
 * The owner's side: every key of the enrollment must have signed it. Returns
 * the guardian entry for the policy. `custodyDomain` is the owner's call —
 * guardians who share a household or an account share one.
 */
export async function acceptEnrollment(input: {
  invite: Invite;
  enrollment: BoundaryValue;
  custodyDomain: string;
  contactRef: string | null;
  now: Date;
}): Promise<Guardian> {
  const { invite } = input;
  const enrollment = EnrollmentSchema.parse(input.enrollment);
  if (enrollment.inviteId !== invite.inviteId) {
    throw new EnrollmentError(
      "invite",
      "this enrollment answers a different invite",
    );
  }
  if (input.now.getTime() > new Date(invite.expiresAt).getTime()) {
    throw new EnrollmentError("expired", "the invite has lapsed");
  }
  const challenge = enrollmentChallenge(
    invite,
    enrollment.guardianId,
    enrollment.hpkePublicKey,
    enrollment.credentials.map((c) => c.credentialId),
  );
  const credentials: GuardianCredential[] = [];
  for (const entry of enrollment.credentials) {
    const credential: GuardianCredential = {
      credentialId: entry.credentialId,
      publicKey: entry.publicKey,
      alg: entry.alg,
      label: entry.label,
      prf: entry.prf,
      addedAt: input.now.toISOString(),
    };
    try {
      await verifyAssertion(credential, entry.proof, {
        challenge,
        rpId: invite.rpId,
        origins: invite.origins,
        requireUserVerification: invite.requireUserVerification,
        lastCounter: 0,
      });
    } catch (error) {
      if (error instanceof AssertionError) {
        throw new EnrollmentError(
          error.code,
          `${entry.label}: ${error.message}`,
        );
      }
      throw error;
    }
    credentials.push(credential);
  }
  fromB64url(enrollment.hpkePublicKey);
  return {
    id: enrollment.guardianId,
    name: enrollment.name,
    contactRef: input.contactRef,
    custodyDomain: input.custodyDomain,
    hpkePublicKey: enrollment.hpkePublicKey,
    credentials,
  };
}
