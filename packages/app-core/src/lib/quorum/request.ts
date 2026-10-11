/**
 * A request is what guardians approve. Its digest is the one value every
 * approval is bound to, and its sentence is derived from its fields — never
 * taken on trust — so the operation a guardian reads is the operation the
 * digest covers (ADR 0086: displayed == approved == executed).
 *
 * Two clocks, kept apart on purpose. The approval window is short and
 * coordinates a ceremony; the release delay is long and gives the owner time
 * to notice and cancel.
 */

import { sha256 } from "@noble/hashes/sha2";
import type { BoundaryValue } from "@opensesame/os-domain";
import { fromB64url, randomBytes, toB64url, toHex } from "./bytes.js";
import { canonicalize, frame, framedDigest } from "./canonical.js";
import {
  type CirclePolicy,
  type Grant,
  type Operation,
  type QuorumRequest,
  QuorumRequestSchema,
  type SignedPolicy,
} from "./types.js";

const REQUEST_PURPOSE = "opensesame:quorum-request:v1";
const CHALLENGE_PURPOSE = "opensesame:quorum-challenge:v1";

export type Phase = "approve" | "release";

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export function requestDigest(request: QuorumRequest): string {
  return framedDigest(REQUEST_PURPOSE, [canonicalize(request)]);
}

/**
 * The WebAuthn challenge for one phase of one request. The phase is inside it,
 * so an approval assertion cannot be offered as a release, or the reverse.
 */
export function phaseChallenge(phase: Phase, digest: string): Uint8Array {
  return sha256(frame([CHALLENGE_PURPOSE, phase, digest]));
}

/** A short, comparable name for a public key: read it aloud, check it elsewhere. */
export function keyFingerprint(publicKeyB64url: string): string {
  const hex = toHex(sha256(fromB64url(publicKeyB64url)).slice(0, 8));
  return (hex.match(/.{4}/g) ?? []).join("-");
}

function at(iso: string): string {
  return new Date(iso).toISOString().replace(".000Z", "Z");
}

type Describable = Pick<
  QuorumRequest,
  | "operation"
  | "scope"
  | "grant"
  | "recipient"
  | "approveBy"
  | "releaseNotBefore"
  | "expiresAt"
>;

function hours(seconds: number): string {
  const h = seconds / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hour(s)`;
}

/** What the request does, in a clause. Every word comes from a request field. */
function clause(request: Describable): string {
  const { scope, recipient, grant } = request;
  const target = `"${recipient.label}" (key ${keyFingerprint(recipient.hpkePublicKey)})`;
  switch (request.operation) {
    case "recover-collection":
      return `Release the recovery key for "${scope.collection}" to ${target}`;
    case "grant-access":
      return grant
        ? `Let ${grant.principalId} ${grant.policy} the ${grant.resourceKind} "${grant.resourceLabel}" for ${hours(grant.durationSeconds)}`
        : "Grant access";
    case "replace-owner-credential":
      return `Replace the owner's sign-in credential with a key held by ${target}`;
    case "export-items":
      return `Export ${scope.items.length || "all"} item(s) from "${scope.collection}" to ${target}`;
  }
}

/** The sentence guardians read. Built from the request's own fields. */
export function describeRequest(
  policy: CirclePolicy,
  request: Describable,
): string {
  return (
    `${clause(request)}, as circle "${policy.label}" decides. ` +
    `Approvals close ${at(request.approveBy)}; this can take effect ` +
    `from ${at(request.releaseNotBefore)} until ${at(request.expiresAt)}.`
  );
}

export type NewRequest = Readonly<{
  signedPolicy: SignedPolicy;
  operation: Operation;
  /** What a `grant-access` request asks for; required there, refused elsewhere. */
  grant?: Grant;
  scopeItems?: readonly string[];
  recipientPublicKey: string;
  recipientLabel: string;
  now: Date;
}>;

export function createRequest(input: NewRequest): QuorumRequest {
  const { policy, digest } = input.signedPolicy;
  if (!policy.operations.includes(input.operation)) {
    throw new RequestError(
      "operation_not_governed",
      "this circle does not govern that operation",
    );
  }
  if ((input.operation === "grant-access") !== (input.grant !== undefined)) {
    throw new RequestError(
      "grant",
      "a grant belongs to a grant-access request, and only to one",
    );
  }
  const created = input.now.getTime();
  const after = (seconds: number) =>
    new Date(created + seconds * 1000).toISOString();
  const body = {
    v: 1 as const,
    requestId: toB64url(randomBytes(16)),
    circleId: policy.circleId,
    policyDigest: digest,
    epoch: policy.epoch,
    operation: input.operation,
    scope: {
      collection: policy.collection,
      items: [...(input.scopeItems ?? [])],
    },
    recipient: {
      hpkePublicKey: input.recipientPublicKey,
      label: input.recipientLabel,
    },
    grant: input.grant,
    createdAt: input.now.toISOString(),
    approveBy: after(policy.approvalWindowSec),
    releaseNotBefore: after(policy.releaseDelaySec),
    expiresAt: after(policy.requestLifetimeSec),
  };
  return QuorumRequestSchema.parse({
    ...body,
    summary: describeRequest(policy, body),
  });
}

function sameInstant(a: string, b: string): boolean {
  return new Date(a).getTime() === new Date(b).getTime();
}

/**
 * A request as received, checked against the policy it claims to be under:
 * the timings are the policy's own, the sentence is the one its fields make,
 * and nothing in it is a free choice of whoever sent it.
 */
export function checkRequest(
  input: BoundaryValue,
  signedPolicy: SignedPolicy,
): QuorumRequest {
  const request = QuorumRequestSchema.parse(input);
  const { policy, digest } = signedPolicy;
  const fail = (code: string, message: string): never => {
    throw new RequestError(code, message);
  };
  if (request.circleId !== policy.circleId)
    fail("circle", "another circle's request");
  if (request.policyDigest !== digest)
    fail("policy_digest", "raised under a different policy");
  if (request.epoch !== policy.epoch)
    fail("epoch", "raised under a different epoch");
  if (!policy.operations.includes(request.operation)) {
    fail(
      "operation_not_governed",
      "this circle does not govern that operation",
    );
  }
  if (
    (request.operation === "grant-access") !==
    (request.grant !== undefined)
  ) {
    fail("grant", "a grant belongs to a grant-access request, and only to one");
  }
  if (request.scope.collection !== policy.collection)
    fail("scope", "another collection");
  const created = new Date(request.createdAt).getTime();
  const offset = (seconds: number) =>
    new Date(created + seconds * 1000).toISOString();
  if (
    !sameInstant(request.approveBy, offset(policy.approvalWindowSec)) ||
    !sameInstant(request.releaseNotBefore, offset(policy.releaseDelaySec)) ||
    !sameInstant(request.expiresAt, offset(policy.requestLifetimeSec))
  ) {
    fail("timing", "the request's timings are not the policy's");
  }
  if (request.summary !== describeRequest(policy, request)) {
    fail("summary", "the sentence does not describe the request");
  }
  return request;
}
