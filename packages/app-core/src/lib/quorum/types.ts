/**
 * The quorum documents (ADR 0186), as strict schemas. Every one of them
 * crosses a trust boundary — a guardian's device, a recipient's, a pasted
 * packet — so each is parsed, never cast.
 *
 * ERC-7093 separates three questions and so does this file: who a guardian is
 * and how they authenticate (`Guardian`), whether a set of them satisfies the
 * policy (`CirclePolicy` groups), and what that set may then do (`Operation`).
 */

import { z } from "zod";

const B64URL = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(8192);
const ISO = z.string().datetime({ offset: true });
const DIGEST = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ID = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const LABEL = z.string().min(1).max(120);

export const OPERATIONS = [
  "recover-collection",
  "grant-access",
  "replace-owner-credential",
  "export-items",
] as const;
export const OperationSchema = z.enum(OPERATIONS);
export type Operation = z.infer<typeof OperationSchema>;

/** COSE algorithm identifiers: ES256 and EdDSA. */
export const AlgSchema = z.union([z.literal(-7), z.literal(-8)]);

export const GuardianCredentialSchema = z
  .object({
    credentialId: B64URL,
    /** SubjectPublicKeyInfo, DER, as `AuthenticatorAttestationResponse.getPublicKey()`. */
    publicKey: B64URL,
    alg: AlgSchema,
    label: LABEL,
    /** Enrollment saw the same PRF output twice. */
    prf: z.boolean(),
    addedAt: ISO,
  })
  .strict();
export type GuardianCredential = z.infer<typeof GuardianCredentialSchema>;

export const GuardianSchema = z
  .object({
    id: ID,
    name: LABEL,
    /** The vault `contact` item this guardian is, if any. */
    contactRef: ID.nullable(),
    /** Guardians in one domain (a household, a shared account) count as one for independence. */
    custodyDomain: ID,
    /** X25519 key the owner's share was sealed to at enrollment. */
    hpkePublicKey: B64URL,
    /** Alternatives for one guardian: a backup key adds availability, never authority. */
    credentials: z.array(GuardianCredentialSchema).min(1).max(8),
  })
  .strict();
export type Guardian = z.infer<typeof GuardianSchema>;

export const GroupSchema = z
  .object({
    id: ID,
    threshold: z.number().int().min(1).max(16),
    guardianIds: z.array(ID).min(1).max(16),
  })
  .strict();
export type Group = z.infer<typeof GroupSchema>;

export const CirclePolicySchema = z
  .object({
    v: z.literal(1),
    circleId: ID,
    epoch: z.number().int().min(1),
    label: LABEL,
    /** What the circle protects, as the owner names it. */
    collection: LABEL,
    rpId: z.string().min(1).max(253),
    origins: z.array(z.string().url().max(256)).min(1).max(8),
    /** Ed25519 key that signs this policy and any cancellation. */
    ownerKey: B64URL,
    groupThreshold: z.number().int().min(1).max(16),
    groups: z.array(GroupSchema).min(1).max(16),
    guardians: z.array(GuardianSchema).min(1).max(32),
    /** guardianId -> `sha256:` commitment to the share that guardian holds. */
    shareCommitments: z.record(ID, DIGEST),
    operations: z.array(OperationSchema).min(1).max(OPERATIONS.length),
    /** How long approvals may be gathered after a request is raised. */
    approvalWindowSec: z
      .number()
      .int()
      .min(60)
      .max(7 * 86400),
    /** How long after a request is raised before any share may be released. */
    releaseDelaySec: z
      .number()
      .int()
      .min(0)
      .max(90 * 86400),
    /** How long a raised request stays alive in all. */
    requestLifetimeSec: z
      .number()
      .int()
      .min(300)
      .max(120 * 86400),
    requireUserVerification: z.boolean(),
    createdAt: ISO,
  })
  .strict();
export type CirclePolicy = z.infer<typeof CirclePolicySchema>;

/** A policy and the owner's Ed25519 signature over its digest. */
export const SignedPolicySchema = z
  .object({
    policy: CirclePolicySchema,
    digest: DIGEST,
    signature: B64URL,
  })
  .strict();
export type SignedPolicy = z.infer<typeof SignedPolicySchema>;

/**
 * The standing share a `grant-access` request asks for, in the shape the share
 * ledger writes (`local-share-grants`). Carried inside the request so the
 * share that is written is the share that was approved, field for field.
 */
export const GrantSchema = z
  .object({
    principalId: ID,
    resourceKind: z.enum(["vault", "connection", "folder", "item"]),
    resourceId: z.string().min(1).max(128),
    resourceLabel: z.string().min(1).max(128),
    policy: z.string().min(1).max(32),
    durationSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86400),
  })
  .strict();
export type Grant = z.infer<typeof GrantSchema>;

export const QuorumRequestSchema = z
  .object({
    v: z.literal(1),
    requestId: B64URL,
    circleId: ID,
    policyDigest: DIGEST,
    epoch: z.number().int().min(1),
    operation: OperationSchema,
    scope: z
      .object({
        collection: LABEL,
        /** Empty means the whole collection. */
        items: z.array(ID).max(256),
      })
      .strict(),
    recipient: z.object({ hpkePublicKey: B64URL, label: LABEL }).strict(),
    /** Present for `grant-access` and for nothing else. */
    grant: GrantSchema.optional(),
    /** The sentence every screen shows and every guardian approves. */
    summary: z.string().min(1).max(600),
    createdAt: ISO,
    approveBy: ISO,
    releaseNotBefore: ISO,
    expiresAt: ISO,
  })
  .strict();
export type QuorumRequest = z.infer<typeof QuorumRequestSchema>;

export const AssertionProofSchema = z
  .object({
    clientDataJSON: B64URL,
    authenticatorData: B64URL,
    signature: B64URL,
  })
  .strict();
export type AssertionProof = z.infer<typeof AssertionProofSchema>;

export const ApprovalSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("approval"),
    requestDigest: DIGEST,
    guardianId: ID,
    credentialId: B64URL,
    assertion: AssertionProofSchema,
  })
  .strict();
export type Approval = z.infer<typeof ApprovalSchema>;

export const ReleaseSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("release"),
    requestDigest: DIGEST,
    guardianId: ID,
    credentialId: B64URL,
    assertion: AssertionProofSchema,
    /** The share, HPKE-sealed to `request.recipient`. */
    sealed: z.object({ enc: B64URL, ciphertext: B64URL }).strict(),
  })
  .strict();
export type Release = z.infer<typeof ReleaseSchema>;

export const CancellationSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("cancellation"),
    circleId: ID,
    requestDigest: DIGEST,
    issuedAt: ISO,
    signature: B64URL,
  })
  .strict();
export type Cancellation = z.infer<typeof CancellationSchema>;
