import type { CircleDraft, CreatedCircle } from "../circle.js";
import { encodePacket } from "../packets.js";
import { type PolicyWarning, policyWarnings } from "../policy.js";
import type { CircleState } from "../records.js";
import type { CirclePolicy, Group, Guardian, Operation } from "../types.js";
import { KEYS, type OwnerDraft, OwnerDraftSchema, load } from "./docs.js";
import { DeskError, type DeskPorts, type OwnedRecord } from "./ports.js";

/** Who sits in which group, and how many it takes. */
export type RuleInput = Readonly<{
  groups: readonly Group[];
  groupThreshold: number;
}>;

/** The clocks, and whether a key must prove a PIN or biometric as well as a touch. */
export type TimingInput = Readonly<{
  approvalWindowSec: number;
  releaseDelaySec: number;
  requestLifetimeSec: number;
  requireUserVerification: boolean;
}>;

export const DEFAULT_TIMING: TimingInput = {
  approvalWindowSec: 10 * 60,
  releaseDelaySec: 24 * 3600,
  requestLifetimeSec: 7 * 86400,
  requireUserVerification: true,
};

/** One guardian's packet from the owner, and who it is for. */
export type Handout = Readonly<{
  guardianId: string;
  name: string;
  /** One line of text: the policy and this guardian's share. */
  packet: string;
}>;

/** What a screen shows after a circle is made or changed. */
export type Dealt = Readonly<{
  circleId: string;
  welcomes: readonly Handout[];
  /** The policy alone, for a guardian who has left the circle. */
  notices: readonly Handout[];
  /** The recovery bundle as file text, or `null` when the circle holds no secret. */
  bundleFile: string | null;
  warnings: readonly PolicyWarning[];
}>;

export function inviteText(draft: OwnerDraft): string {
  return encodePacket({ kind: "invite", value: draft.invite });
}

export async function ownedRecord(
  ports: DeskPorts,
  circleId: string,
): Promise<OwnedRecord> {
  const found = (await ports.records.owned()).find(
    (r) => r.signedPolicy.policy.circleId === circleId,
  );
  if (!found) throw new DeskError("no_circle", "no such circle");
  return found;
}

/** The circle being made or changed, with the guardians who have answered so far; `null` if none. */
export async function readDraft(
  ports: DeskPorts,
  circleId: string,
): Promise<OwnerDraft | null> {
  return load(ports.pending, KEYS.draft(circleId), OwnerDraftSchema);
}

export async function draftOf(ports: DeskPorts, circleId: string) {
  const draft = await load(
    ports.pending,
    KEYS.draft(circleId),
    OwnerDraftSchema,
  );
  if (!draft) throw new DeskError("no_draft", "start by inviting people");
  return draft;
}

export function operationsFor(recovers: boolean): Operation[] {
  return recovers ? ["recover-collection", "grant-access"] : ["grant-access"];
}

export function circleDraftOf(
  base: Pick<
    CirclePolicy,
    "circleId" | "label" | "collection" | "rpId" | "origins"
  >,
  recovers: boolean,
  guardians: readonly Guardian[],
  rule: RuleInput,
  timing: TimingInput,
): CircleDraft {
  return {
    circleId: base.circleId,
    label: base.label,
    collection: base.collection,
    rpId: base.rpId,
    origins: base.origins,
    guardians,
    groups: rule.groups,
    groupThreshold: rule.groupThreshold,
    operations: operationsFor(recovers),
    ...timing,
  };
}

export function draftForPreview(
  ports: DeskPorts,
  draft: OwnerDraft,
  rule: RuleInput,
  timing: TimingInput,
): CircleDraft {
  return circleDraftOf(
    {
      circleId: draft.circleId,
      label: draft.label,
      collection: draft.collection,
      rpId: ports.rpId,
      origins: [ports.origin],
    },
    draft.recovers,
    draft.guardians,
    rule,
    timing,
  );
}

export function dealt(
  created: CreatedCircle,
  guardians: readonly Guardian[],
  retired: readonly Guardian[],
): Dealt {
  const { signedPolicy } = created;
  const welcomes = guardians.map((g) => ({
    guardianId: g.id,
    name: g.name,
    packet: encodePacket({
      kind: "welcome",
      value: {
        signedPolicy,
        delivery: created.deliveries.find((d) => d.guardianId === g.id) ?? null,
      },
    }),
  }));
  const notices = retired.map((g) => ({
    guardianId: g.id,
    name: g.name,
    packet: encodePacket({ kind: "policy", value: signedPolicy }),
  }));
  return {
    circleId: signedPolicy.policy.circleId,
    welcomes,
    notices,
    bundleFile: created.bundle ? JSON.stringify(created.bundle) : null,
    warnings: policyWarnings(signedPolicy.policy),
  };
}

export function stateAfter(created: CreatedCircle): CircleState {
  return created.bundle ? "inviting" : "armed";
}
