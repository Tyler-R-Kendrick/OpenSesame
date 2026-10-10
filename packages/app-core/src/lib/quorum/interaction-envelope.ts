/**
 * The Interaction that fronts a quorum request: how it is made from a request,
 * and how one is checked on the way back in (ADR 0186, ADR 0086). The design,
 * and the three digests it keeps apart, are described in `interaction.ts`.
 */

import {
  type BoundaryValue,
  type Interaction,
  type JsonObject,
  assertAuthorizationDetails,
  canonicalize,
  deriveBindingMessage,
} from "@opensesame/os-domain";
import { z } from "zod";
import { randomBytes, toB64url } from "./bytes.js";
import { framedDigest } from "./canonical.js";
import { verifySignedPolicy } from "./policy.js";
import { checkRequest, keyFingerprint, requestDigest } from "./request.js";
import {
  OperationSchema,
  QuorumRequestSchema,
  type SignedPolicy,
} from "./types.js";

export const QUORUM_DETAIL_TYPE = "quorum_request";

/** Same purpose string as `REQUEST_DIGEST_PURPOSE` in os-domain; the vectors pin it. */
const INTERACTION_PURPOSE = "opensesame:interaction-request:v1";
const KIND = "authorization_request" as const;
const SUBJECT_PREFIX = "quorum:";
const CIRCLE_PREFIX = "quorum-circle:";
const RECIPIENT_PREFIX = "quorum-recipient:";

export class QuorumInteractionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QuorumInteractionError";
  }
}

export function refuse(code: string, message: string): never {
  throw new QuorumInteractionError(code, message);
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The one authorization detail, a closed list: every key is covered by `D_i`,
 * and nothing else rides in the envelope. Keys that mirror the request keep
 * its names and its validators.
 */
const DetailSchema = QuorumRequestSchema.pick({
  circleId: true,
  epoch: true,
  requestId: true,
  policyDigest: true,
  summary: true,
  approveBy: true,
  releaseNotBefore: true,
})
  .extend({
    type: z.literal(QUORUM_DETAIL_TYPE),
    actions: z.tuple([OperationSchema]),
    /** The collection the circle protects, as the owner names it. */
    identifier: z.string().min(1).max(120),
    /** `D_q`. */
    quorumRequestDigest: z.string().regex(DIGEST),
    /** Who releases a share and when: stated, never carried. */
    releaseRule: z.enum(["guardian-devices-after-delay", "none"]),
  })
  .strict();
export type QuorumDetail = z.infer<typeof DetailSchema>;

function detailOf(
  request: z.infer<typeof QuorumRequestSchema>,
  quorumDigest: string,
): QuorumDetail {
  return {
    type: QUORUM_DETAIL_TYPE,
    actions: [request.operation],
    identifier: request.scope.collection,
    circleId: request.circleId,
    epoch: request.epoch,
    requestId: request.requestId,
    quorumRequestDigest: quorumDigest,
    policyDigest: request.policyDigest,
    summary: request.summary,
    approveBy: request.approveBy,
    releaseNotBefore: request.releaseNotBefore,
    releaseRule:
      request.operation === "recover-collection"
        ? "guardian-devices-after-delay"
        : "none",
  };
}

/** What `canonicalRequestDigest` hashes: the fields `D_i` covers. */
export type RequestFields = Readonly<{
  kind: string;
  subject: string;
  approverRef: string;
  requesterRef: string;
  authorizationDetails: readonly JsonObject[];
  bindingMessage: string;
  resourceRef?: string;
  expiresAt: string;
}>;

/**
 * The interaction request digest, framed as `canonicalRequestDigest` frames
 * it. `spec/conformance/request-digest-vectors.json` is the definition (ADR
 * 0139); `interaction.vectors.test.ts` replays every case through this.
 */
export function interactionRequestDigest(f: RequestFields): string {
  return framedDigest(INTERACTION_PURPOSE, [
    f.kind,
    f.subject,
    f.approverRef,
    f.requesterRef,
    canonicalize([...f.authorizationDetails]),
    f.bindingMessage,
    f.resourceRef ?? "",
    f.expiresAt,
  ]);
}

type Envelope = Readonly<{
  subject: Interaction["subject"];
  approverRef: string;
  requesterRef: string;
  details: readonly JsonObject[];
  bindingMessage: string;
  expiresAt: Date;
}>;

/** `D_i` of a quorum envelope, which names no resource. */
function interactionDigest(e: Envelope): string {
  return interactionRequestDigest({
    kind: KIND,
    subject: `${e.subject.kind}:${e.subject.subjectId}`,
    approverRef: e.approverRef,
    requesterRef: e.requesterRef,
    authorizationDetails: e.details,
    bindingMessage: e.bindingMessage,
    expiresAt: e.expiresAt.toISOString(),
  });
}

/**
 * Front a request with an Interaction: `pending`, approved by nobody.
 *
 * The policy and the request are checked as a ledger would check them, so a
 * request that lies about its timings, sentence or circle is refused here.
 * `id` is the interaction's own random handle, never derived from the request.
 */
export function requestToInteraction(input: {
  signedPolicy: SignedPolicy;
  request: BoundaryValue;
  id?: string;
}): Interaction {
  const signed = verifySignedPolicy(input.signedPolicy);
  const request = checkRequest(input.request, signed);
  const details = [detailOf(request, requestDigest(request))];
  assertAuthorizationDetails(details);
  const subject = {
    kind: KIND,
    subjectId: `${SUBJECT_PREFIX}${request.requestId}`,
  };
  const requesterRef = `${RECIPIENT_PREFIX}${keyFingerprint(request.recipient.hpkePublicKey)}`;
  const bindingMessage = deriveBindingMessage(details);
  const expiresAt = new Date(request.expiresAt);
  return {
    id: input.id ?? toB64url(randomBytes(18)),
    kind: KIND,
    status: "pending",
    subject,
    createdAt: new Date(request.createdAt),
    expiresAt,
    requesterRef,
    requestDigest: interactionDigest({
      subject,
      approverRef: `${CIRCLE_PREFIX}${request.circleId}`,
      requesterRef,
      details,
      bindingMessage,
      expiresAt,
    }),
    bindingMessage,
    authorizationDetails: details,
    assuranceRequired: {
      subjectKind: "human",
      requirePhishingResistance: true,
      requireUserVerification: signed.policy.requireUserVerification,
    },
    version: 1,
  };
}

export type Bound = Readonly<{
  detail: QuorumDetail;
  /** `D_q`, as the envelope carries it. */
  quorum: string;
  /** `D_i`, after it was recomputed from the envelope's own fields. */
  digest: string;
  /** The circle as approver: a handle, not a principal id. */
  circle: string;
}>;

/** A quorum request interaction whose digest covers its own fields, or a refusal. */
export function bind(interaction: Interaction): Bound {
  if (interaction.kind !== KIND || interaction.subject.kind !== KIND) {
    refuse("shape", "this is not a quorum request interaction");
  }
  const [first, ...rest] = interaction.authorizationDetails;
  const parsed = DetailSchema.safeParse(first);
  // zod's strict mode skips an own `__proto__` key and the browser
  // `canonicalize` leaves it out of the hash: a field a reader could be shown
  // that `D_i` does not cover. Every key the envelope holds must be one parsed.
  if (
    !parsed.success ||
    rest.length > 0 ||
    Object.keys(first ?? {}).length !== Object.keys(parsed.data).length
  ) {
    refuse("shape", "the interaction carries no single quorum detail");
  }
  const detail = parsed.data;
  const { requesterRef, requestDigest: carried, expiresAt } = interaction;
  if (
    interaction.subject.subjectId !== `${SUBJECT_PREFIX}${detail.requestId}` ||
    interaction.resourceRef !== undefined ||
    !requesterRef ||
    !carried ||
    !Number.isFinite(expiresAt.getTime())
  ) {
    refuse("shape", "the interaction is not the one its detail describes");
  }
  const bindingMessage = interaction.bindingMessage ?? "";
  const circle = `${CIRCLE_PREFIX}${detail.circleId}`;
  const recomputed = interactionDigest({
    subject: interaction.subject,
    approverRef: circle,
    requesterRef,
    details: interaction.authorizationDetails,
    bindingMessage,
    expiresAt,
  });
  if (
    recomputed !== carried ||
    bindingMessage !== deriveBindingMessage([detail])
  ) {
    refuse("digest", "the interaction's digest does not cover its own fields");
  }
  return {
    detail,
    quorum: detail.quorumRequestDigest,
    digest: carried,
    circle,
  };
}

/** `D_q`, the digest the guardians' approvals are bound to, read from a checked interaction. */
export function quorumDigestOf(interaction: Interaction): string {
  return bind(interaction).quorum;
}
