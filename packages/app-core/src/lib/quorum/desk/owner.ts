/**
 * The owner's side of making and changing a circle (ADR 0186 §10): invite
 * people, accept their enrollments, set the rule and the clocks, deal each
 * guardian their share, and watch the custody receipts come back.
 *
 * Every function is one step of a ceremony, takes the ports it runs against,
 * persists what the next step needs and returns what a screen shows: a packet to
 * hand on, a list to draw, a warning to mark. None holds a key past its step.
 */

import { toB64url } from "../bytes.js";
import type { Json } from "../canonical.js";
import { type CircleDraft, type OwnerKeys, createCircle } from "../circle.js";
import { generateOwnerKeys } from "../circle.js";
import { acceptEnrollment, createInvite, newCircleId } from "../enroll.js";
import { expectPacket } from "../packets.js";
import {
  PolicyError,
  type PolicyWarning,
  assertPolicySound,
  policyWarnings,
} from "../policy.js";
import type { CirclePolicy, Guardian } from "../types.js";
import {
  KEYS,
  type OwnerDraft,
  OwnerDraftSchema,
  ReceiptsSchema,
  keyBytes,
  load,
  save,
} from "./docs.js";
import { keepDealt } from "./owner-dealt.js";
import {
  DEFAULT_TIMING,
  type Dealt,
  type RuleInput,
  type TimingInput,
  dealt,
  draftForPreview,
  draftOf,
  inviteText,
  ownedRecord,
  stateAfter,
} from "./owner-shared.js";
import { DeskError, type DeskPorts } from "./ports.js";

/** A circle being made: its draft, and the invitation to pass to each guardian. */
export type Begun = Readonly<{ draft: OwnerDraft; invite: string }>;

/** Start a circle: owner keys, an invitation to pass to each guardian. */
export async function beginCircle(
  ports: DeskPorts,
  input: {
    label: string;
    collection: string;
    recovers: boolean;
    requireUserVerification?: boolean;
  },
): Promise<Begun> {
  const owner = generateOwnerKeys();
  const circleId = newCircleId();
  const invite = createInvite({
    circleId,
    label: input.label,
    rpId: ports.rpId,
    origins: [ports.origin],
    ownerKey: owner.publicKey,
    requireUserVerification:
      input.requireUserVerification ?? DEFAULT_TIMING.requireUserVerification,
    now: ports.now(),
  });
  const draft: OwnerDraft = {
    v: 1,
    circleId,
    label: input.label,
    collection: input.collection,
    recovers: input.recovers,
    invite,
    ownerSecretKey: toB64url(owner.secretKey),
    guardians: [],
  };
  await save(ports.pending, KEYS.draft(circleId), OwnerDraftSchema, draft);
  return { draft, invite: inviteText(draft) };
}

/** An invitation for more people, to add or replace guardians of a circle that exists. */
export async function inviteMore(
  ports: DeskPorts,
  circleId: string,
): Promise<Begun> {
  const record = await ownedRecord(ports, circleId);
  const { policy } = record.signedPolicy;
  const invite = createInvite({
    circleId,
    label: policy.label,
    rpId: policy.rpId,
    origins: policy.origins,
    ownerKey: policy.ownerKey,
    requireUserVerification: policy.requireUserVerification,
    now: ports.now(),
  });
  const draft: OwnerDraft = {
    v: 1,
    circleId,
    label: policy.label,
    collection: policy.collection,
    recovers: policy.operations.includes("recover-collection"),
    invite,
    ownerSecretKey: null,
    guardians: [],
  };
  await save(ports.pending, KEYS.draft(circleId), OwnerDraftSchema, draft);
  return { draft, invite: inviteText(draft) };
}

/** A guardian's enrollment packet, verified, and held until the circle is made. */
export async function acceptGuardian(
  ports: DeskPorts,
  circleId: string,
  input: {
    packet: string;
    custodyDomain: string;
    contactRef: string | null;
  },
): Promise<Guardian> {
  const draft = await draftOf(ports, circleId);
  const guardian = await acceptEnrollment({
    invite: draft.invite,
    enrollment: expectPacket(input.packet, "enrollment").value,
    custodyDomain: input.custodyDomain,
    contactRef: input.contactRef,
    now: ports.now(),
  });
  const existing = (await ports.records.owned()).find(
    (r) => r.signedPolicy.policy.circleId === circleId,
  );
  const known = [
    ...draft.guardians,
    ...(existing?.signedPolicy.policy.guardians ?? []),
  ];
  if (known.some((g) => g.id === guardian.id)) {
    throw new DeskError(
      "duplicate",
      `${guardian.name} is already in this circle`,
    );
  }
  await save(ports.pending, KEYS.draft(circleId), OwnerDraftSchema, {
    ...draft,
    guardians: [...draft.guardians, guardian],
  });
  return guardian;
}

export async function dropDraftGuardian(
  ports: DeskPorts,
  circleId: string,
  guardianId: string,
): Promise<void> {
  const draft = await draftOf(ports, circleId);
  await save(ports.pending, KEYS.draft(circleId), OwnerDraftSchema, {
    ...draft,
    guardians: draft.guardians.filter((g) => g.id !== guardianId),
  });
}

/**
 * The circle that was begun and never made, if there is one: its draft holds
 * the people who have answered and the key the circle would be signed with, so
 * a screen that was closed can pick up where it stopped. A draft for a circle
 * that already exists (more people being invited) is not one.
 */
export async function unfinishedCircle(
  ports: DeskPorts,
): Promise<OwnerDraft | null> {
  for (const key of await ports.pending.list(KEYS.draft(""))) {
    const draft = await load(ports.pending, key, OwnerDraftSchema).catch(
      () => null,
    );
    if (draft && draft.ownerSecretKey !== null) return draft;
  }
  return null;
}

/** Forget an invitation round: a circle that was never made, or more people for one that was. */
export async function discardDraft(
  ports: DeskPorts,
  circleId: string,
): Promise<void> {
  await ports.pending.remove(KEYS.draft(circleId));
}

export type Preview =
  | Readonly<{ ok: true; warnings: readonly PolicyWarning[] }>
  | Readonly<{ ok: false; code: string; message: string }>;

const PLACEHOLDER = `sha256:${"0".repeat(64)}`;

/** A circle's rule and clocks, checked and advised on before anything is made. Pure. */
export function previewCircle(draft: CircleDraft): Preview {
  const recovers = draft.operations.includes("recover-collection");
  const policy: CirclePolicy = {
    v: 1,
    circleId: draft.circleId,
    epoch: 1,
    label: draft.label,
    collection: draft.collection,
    rpId: draft.rpId,
    origins: [...draft.origins],
    ownerKey: "preview",
    groupThreshold: draft.groupThreshold,
    groups: [...draft.groups],
    guardians: [...draft.guardians],
    shareCommitments: recovers
      ? Object.fromEntries(draft.guardians.map((g) => [g.id, PLACEHOLDER]))
      : {},
    operations: [...draft.operations],
    approvalWindowSec: draft.approvalWindowSec,
    releaseDelaySec: draft.releaseDelaySec,
    requestLifetimeSec: draft.requestLifetimeSec,
    requireUserVerification: draft.requireUserVerification,
    createdAt: new Date(0).toISOString(),
  };
  try {
    assertPolicySound(policy);
  } catch (error) {
    if (error instanceof PolicyError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
  return { ok: true, warnings: policyWarnings(policy) };
}

/** Make the circle: sign the policy, seal the payload, deal every guardian a share. */
export async function createFromDraft(
  ports: DeskPorts,
  circleId: string,
  input: { rule: RuleInput; timing: TimingInput; payload?: Json },
): Promise<Dealt> {
  const draft = await draftOf(ports, circleId);
  if (draft.ownerSecretKey === null) {
    throw new DeskError("exists", "this circle was already made");
  }
  if (draft.guardians.length === 0) {
    throw new DeskError("no_guardians", "invite at least one person first");
  }
  if (draft.recovers && input.payload === undefined) {
    throw new DeskError("payload", "choose what the circle protects");
  }
  const secretKey = keyBytes(draft.ownerSecretKey);
  const owner: OwnerKeys = {
    publicKey: draft.invite.ownerKey,
    secretKey,
  };
  const preview = draftForPreview(ports, draft, input.rule, input.timing);
  const created = await createCircle({
    draft: preview,
    owner,
    payload: input.payload,
    now: ports.now(),
  });
  await ports.records.saveOwned({
    signedPolicy: created.signedPolicy,
    ownerSecretKey: secretKey,
    state: stateAfter(created),
  });
  await save(ports.pending, KEYS.receipts(circleId), ReceiptsSchema, {
    epoch: created.signedPolicy.policy.epoch,
    guardianIds: [],
  });
  await ports.pending.remove(KEYS.draft(circleId));
  const handed = dealt(created, draft.guardians, []);
  const epoch = created.signedPolicy.policy.epoch;
  return { ...handed, kept: await keepDealt(ports, handed, epoch) };
}
