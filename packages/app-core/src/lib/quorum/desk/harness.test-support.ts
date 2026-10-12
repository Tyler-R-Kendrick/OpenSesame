/**
 * Devices for the desk tests: one in-memory page per person, each with its own
 * virtual security key and its own sealed stores, sharing only a clock. What
 * crosses between people is a packet string, exactly as it would be pasted.
 */

import type { Json } from "../canonical.js";
import type { HeldRecord } from "../records.js";
import { KeyRing, ORIGIN, PAYLOAD, RP_ID, T0 } from "../world.test-support.js";
import {
  DEFAULT_TIMING,
  type Dealt,
  type DeskPorts,
  type OwnedRecord,
  type PendingStore,
  type RecordStore,
  acceptGuardian,
  acceptInvitation,
  beginCircle,
  createFromDraft,
  recordReceipt,
  takeWelcome,
} from "./index.js";

export class Clock {
  private t = T0.getTime();
  date = () => new Date(this.t);
  /** Move to `seconds` after the start of the test. */
  at(seconds: number): void {
    this.t = T0.getTime() + seconds * 1000;
  }
}

export function memoryPending(): PendingStore {
  const map = new Map<string, Json>();
  return {
    read: async (key) => {
      const found = map.get(key);
      // A store hands back a copy, as a sealed one does.
      return found === undefined
        ? undefined
        : JSON.parse(JSON.stringify(found));
    },
    write: async (key, value) => {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    remove: async (key) => {
      map.delete(key);
    },
    list: async (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
  };
}

export function memoryRecords(): RecordStore {
  const owned = new Map<string, OwnedRecord>();
  const held = new Map<string, HeldRecord>();
  return {
    owned: async () => [...owned.values()],
    saveOwned: async (r) => {
      owned.set(r.signedPolicy.policy.circleId, r);
    },
    removeOwned: async (id) => {
      owned.delete(id);
    },
    held: async () => [...held.values()],
    saveHeld: async (r) => {
      held.set(r.seat.signedPolicy.policy.circleId, r);
    },
    removeHeld: async (id) => {
      held.delete(id);
    },
  };
}

export type Device = DeskPorts & Readonly<{ ring: KeyRing }>;

/** One person's page: their keys, their stores, the shared clock. */
export type DeviceOptions = Readonly<{
  keys?: number;
  tomb?: string;
  origin?: string;
}>;

export function device(clock: Clock, options: DeviceOptions = {}): Device {
  const ring = new KeyRing(options.keys ?? 1);
  return {
    now: clock.date,
    origin: options.origin ?? ORIGIN,
    rpId: RP_ID,
    ceremony: ring.ceremony(),
    pending: memoryPending(),
    records: memoryRecords(),
    tomb: options.tomb ?? "tomb",
    ring,
  };
}

export const NAMES = ["Ada", "Ben", "Cy"] as const;

export type ArmedOptions = Readonly<{
  names?: readonly string[];
  threshold?: number;
  recovers?: boolean;
  payload?: Json;
  /** The owner's vault, for a circle whose approvals write a share. */
  ownerTomb?: string;
}>;

export type Armed = Readonly<{
  owner: Device;
  people: ReadonlyMap<string, Device>;
  circleId: string;
  dealt: Dealt;
  guardianIds: readonly string[];
}>;

/**
 * An owner invites people, they agree, the circle is made, and each guardian
 * takes a share and sends back a receipt. `recovers: false` makes an
 * approvals-only circle, which has no shares and no receipts.
 */
export async function armedCircle(
  clock: Clock,
  options: ArmedOptions = {},
): Promise<Armed> {
  const names = options.names ?? NAMES;
  const recovers = options.recovers ?? true;
  const owner = device(clock, { tomb: options.ownerTomb });
  const people = new Map(names.map((name) => [name, device(clock)]));
  const { draft, invite } = await beginCircle(owner, {
    label: "Family",
    collection: "Emergency",
    recovers,
  });
  const guardianIds: string[] = [];
  for (const [name, who] of people) {
    const { enrollment } = await acceptInvitation(who, {
      packet: invite,
      name,
      keyLabels: ["Security key"],
    });
    const guardian = await acceptGuardian(owner, draft.circleId, {
      packet: enrollment,
      custodyDomain: `home-${name}`,
      contactRef: null,
    });
    guardianIds.push(guardian.id);
  }
  const dealt = await createFromDraft(owner, draft.circleId, {
    rule: oneGroup(guardianIds, options.threshold ?? 2),
    timing: DEFAULT_TIMING,
    payload: recovers ? (options.payload ?? PAYLOAD) : undefined,
  });
  for (const welcome of dealt.welcomes) {
    const who = people.get(welcome.name);
    if (!who) throw new Error(`no ${welcome.name}`);
    const taken = await takeWelcome(who, welcome.packet);
    if (taken.receipt)
      await recordReceipt(owner, draft.circleId, taken.receipt);
  }
  return { owner, people, circleId: draft.circleId, dealt, guardianIds };
}

export function oneGroup(ids: readonly string[], threshold: number) {
  return {
    groups: [{ id: "all", threshold, guardianIds: [...ids] }],
    groupThreshold: 1,
  };
}

export function who(armed: Armed, name: string): Device {
  const found = armed.people.get(name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}
