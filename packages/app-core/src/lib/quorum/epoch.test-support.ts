/**
 * Moving a test circle to its next epoch the way the two sides would: the owner
 * reissues, each guardian who stays takes a new share against the policy they
 * hold, and a newcomer enrolls and takes theirs.
 */

import type { Json } from "./canonical.js";
import type { CircleDraft } from "./circle.js";
import { acceptEnrollment, createInvite, enrollGuardian } from "./enroll.js";
import { type Reissued, reissueCircle } from "./epoch.js";
import { acceptDelivery } from "./guardian.js";
import {
  KeyRing,
  ORIGIN,
  type Person,
  RP_ID,
  T0,
  type World,
} from "./world.test-support.js";

export const DAY_MS = 86_400_000;

/** A person who has enrolled for this circle and is not yet in its policy. */
export async function enrollNewcomer(
  world: World,
  name: string,
): Promise<Person> {
  const invite = createInvite({
    circleId: world.circleId,
    label: "Family",
    rpId: RP_ID,
    origins: [ORIGIN],
    ownerKey: world.owner.publicKey,
    requireUserVerification: true,
    now: T0,
  });
  const ring = new KeyRing(1);
  const ceremony = ring.ceremony();
  const { enrollment, secrets } = await enrollGuardian({
    invite,
    currentOrigin: ORIGIN,
    name,
    keyLabels: ["Security key"],
    ceremony,
    guardianId: `g-${name.toLowerCase()}`,
  });
  const guardian = await acceptEnrollment({
    invite,
    enrollment,
    custodyDomain: `home-${name.toLowerCase()}`,
    contactRef: null,
    now: T0,
  });
  return {
    id: guardian.id,
    name,
    ring,
    ceremony,
    guardian,
    secrets,
    enrollment,
  };
}

export type Change = Readonly<{
  /** Names to take out of the circle. */
  drop?: readonly string[];
  /** Newcomers who have enrolled and now join. */
  add?: readonly Person[];
  /** The member threshold of the circle's one group. */
  threshold?: number;
  now?: Date;
  payload?: Json;
}>;

/** The draft for the next epoch of a one-group circle. */
export function draftAfter(world: World, change: Change): CircleDraft {
  const { policy } = world.created.signedPolicy;
  const group = policy.groups[0];
  if (!group) throw new Error("no group");
  const dropped = new Set(
    (change.drop ?? []).map((name) => {
      const who = world.people.get(name);
      if (!who) throw new Error(`no ${name}`);
      return who.id;
    }),
  );
  const guardians = [
    ...policy.guardians.filter((g) => !dropped.has(g.id)),
    ...(change.add ?? []).map((p) => p.guardian),
  ];
  return {
    circleId: policy.circleId,
    label: policy.label,
    collection: policy.collection,
    rpId: policy.rpId,
    origins: policy.origins,
    guardians,
    groups: [
      {
        id: group.id,
        threshold: change.threshold ?? group.threshold,
        guardianIds: guardians.map((g) => g.id),
      },
    ],
    groupThreshold: policy.groupThreshold,
    operations: policy.operations,
    approvalWindowSec: policy.approvalWindowSec,
    releaseDelaySec: policy.releaseDelaySec,
    requestLifetimeSec: policy.requestLifetimeSec,
    requireUserVerification: policy.requireUserVerification,
  };
}

export type NextEpoch = Readonly<{
  /** The circle as it is now: new policy, new bundle, people who stayed or joined. */
  world: World;
  reissued: Reissued;
}>;

export async function nextEpoch(
  world: World,
  change: Change = {},
): Promise<NextEpoch> {
  const draft = draftAfter(world, change);
  const reissued = await reissueCircle({
    previous: world.created.signedPolicy,
    owner: world.owner,
    draft,
    payload: world.created.bundle
      ? (change.payload ?? world.payload)
      : undefined,
    now: change.now ?? new Date(T0.getTime() + DAY_MS),
  });
  const people = new Map<string, Person>();
  const stayed = [...world.people.values()].filter((p) =>
    reissued.kept.includes(p.id),
  );
  for (const who of [...stayed, ...(change.add ?? [])]) {
    const delivery = reissued.deliveries.find((d) => d.guardianId === who.id);
    if (!delivery) {
      people.set(who.name, who);
      continue;
    }
    const accepted = await acceptDelivery({
      delivery,
      signedPolicy: reissued.signedPolicy,
      pinnedOwnerKey: world.owner.publicKey,
      guardianId: who.id,
      hpkeSecretKey: who.secrets.hpkeSecretKey,
      ceremony: who.ceremony,
      replaces: who.holding?.signedPolicy,
    });
    people.set(who.name, {
      ...who,
      holding: accepted.holding,
      receipt: accepted.receipt,
    });
  }
  return {
    world: { ...world, people, created: reissued },
    reissued,
  };
}
