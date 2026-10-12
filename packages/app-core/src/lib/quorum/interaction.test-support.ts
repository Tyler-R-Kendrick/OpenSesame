/**
 * Helpers for the interaction tests: a three-guardian circle that governs all
 * four operations, a request raised in it with a controllable clock, and the
 * adapter's calls with the plumbing filled in.
 */

import { InteractionDetailResponseSchema } from "@opensesame/contracts";
import type { BoundaryValue, Interaction } from "@opensesame/os-domain";
import { expect } from "vitest";
import { buildApproval } from "./approve.js";
import { toB64url } from "./bytes.js";
import { generateKeyPair } from "./hpke.js";
import { interactionRequestDigest } from "./interaction-envelope.js";
import {
  QuorumInteractionError,
  approvalToProof,
  interactionSettlement,
  requestToInteraction,
} from "./interaction.js";
import { QuorumLedger, signCancellation } from "./ledger.js";
import { clockAt } from "./protocol.test-support.js";
import { createRequest, requestDigest } from "./request.js";
import {
  type Grant,
  OPERATIONS,
  type Operation,
  type QuorumRequest,
  type SignedPolicy,
} from "./types.js";
import { type World, buildWorld, person } from "./world.test-support.js";

export const ZERO = `sha256:${"0".repeat(64)}`;

const NAMES = ["Ada", "Ben", "Cy"];
const GRANT: Grant = {
  principalId: "p1",
  resourceKind: "item",
  resourceId: "bank-login",
  resourceLabel: "Bank login",
  policy: "read",
  durationSeconds: 3600,
};

export type Rig = {
  signedPolicy: SignedPolicy;
  request: QuorumRequest;
  ledger: QuorumLedger;
  at: ReturnType<typeof clockAt>;
};

export function codeOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof QuorumInteractionError) return error.code;
    throw error;
  }
  return "accepted";
}

function open(world: World, operation: Operation = "grant-access") {
  const at = clockAt(0);
  const signedPolicy = world.created.signedPolicy;
  const grant = operation === "grant-access" ? GRANT : undefined;
  const request = createRequest({
    signedPolicy,
    operation,
    grant,
    recipientPublicKey: toB64url(generateKeyPair().publicKey),
    recipientLabel: "New laptop",
    now: at.date(),
  });
  const ledger = QuorumLedger.open(signedPolicy, request, at.now);
  const interaction = requestToInteraction({ signedPolicy, request });
  return { signedPolicy, request, ledger, at, interaction };
}

const about = (rig: Rig, interaction: Interaction) => ({
  interaction,
  request: rig.request,
  signedPolicy: rig.signedPolicy,
});

function settle(
  rig: Rig,
  interaction: Interaction,
  verdict = rig.ledger.verdict(),
) {
  const now = rig.at.date();
  return interactionSettlement({ ...about(rig, interaction), verdict, now });
}

function proofOf(
  rig: Rig,
  interaction: Interaction,
  approval: BoundaryValue,
  verdict = rig.ledger.verdict(),
) {
  const verifiedAt = rig.at.date();
  return approvalToProof({
    ...about(rig, interaction),
    approval,
    verdict,
    verifiedAt,
  });
}

async function approveOne(world: World, rig: Rig, name: string, submit = true) {
  const who = person(world, name);
  const approval = await buildApproval({
    seat: { signedPolicy: rig.signedPolicy, guardianId: who.id },
    request: rig.request,
    ceremony: who.ceremony,
    now: rig.at.date(),
  });
  if (submit) {
    expect(await rig.ledger.submitApproval(approval)).toEqual({ ok: true });
  }
  return approval;
}

const cancel = (world: World, rig: Rig) =>
  rig.ledger.cancel(
    signCancellation({
      circleId: world.circleId,
      requestDigest: requestDigest(rig.request),
      ownerSecretKey: world.owner.secretKey,
      now: rig.at.date(),
    }),
  );

/** `D_i` recomputed over the envelope's own fields, as anyone who knows the framing can. */
function redigest(world: World, i: Interaction): string {
  return interactionRequestDigest({
    kind: i.kind,
    subject: `${i.subject.kind}:${i.subject.subjectId}`,
    approverRef: `quorum-circle:${world.circleId}`,
    requesterRef: i.requesterRef ?? "",
    authorizationDetails: i.authorizationDetails,
    bindingMessage: i.bindingMessage ?? "",
    expiresAt: i.expiresAt.toISOString(),
  });
}

/** The interaction as the Identity API's detail route would send it. */
const wire = (i: Interaction) =>
  InteractionDetailResponseSchema.parse({
    kind: i.kind,
    status: i.status,
    expiresAt: i.expiresAt.toISOString(),
    requiresApprover: true,
    id: i.id,
    requesterRef: i.requesterRef,
    bindingMessage: i.bindingMessage,
    requestDigest: i.requestDigest,
    authorizationDetails: i.authorizationDetails,
    createdAt: i.createdAt.toISOString(),
  });

export async function harness() {
  const world = await buildWorld({
    names: NAMES,
    groups: [{ id: "g", threshold: 2, members: NAMES }],
    operations: OPERATIONS,
  });
  return {
    world,
    open: (operation?: Operation) => open(world, operation),
    settle,
    proofOf,
    approveOne: (rig: Rig, name: string, submit?: boolean) =>
      approveOne(world, rig, name, submit),
    approveWith: async (rig: Rig, names: readonly string[]) => {
      for (const name of names) await approveOne(world, rig, name);
    },
    cancel: (rig: Rig) => cancel(world, rig),
    redigest: (i: Interaction) => redigest(world, i),
    wire,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;
