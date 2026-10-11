/**
 * A whole circle for tests: an owner, guardians with real (virtual) security
 * keys, enrollment through the real ceremony adapter, circle creation,
 * delivery, wrapping and custody receipts. Tests then raise requests against
 * it and try to break it.
 */

import { fromB64url, toB64url } from "./bytes.js";
import type { Json } from "./canonical.js";
import { type Ceremony, webauthnCeremony } from "./ceremony.js";
import {
  type CircleDraft,
  type CreatedCircle,
  type OwnerKeys,
  createCircle,
  generateOwnerKeys,
} from "./circle.js";
import {
  type Enrollment,
  type GuardianSecrets,
  type Invite,
  acceptEnrollment,
  createInvite,
  enrollGuardian,
  newCircleId,
} from "./enroll.js";
import {
  type CustodyReceipt,
  type Holding,
  acceptDelivery,
  verifyCustodyReceipt,
} from "./guardian.js";
import type { Group, Guardian, Operation } from "./types.js";
import {
  VirtualAuthenticator,
  type VirtualOptions,
  asContainer,
} from "./virtual-authenticator.test-support.js";

export const ORIGIN = "https://vault.example.test";
export const RP_ID = "vault.example.test";
export const T0 = new Date("2026-10-10T12:00:00.000Z");

/** One guardian's physical keys. A backup key is a second entry. */
export class KeyRing {
  readonly keys: VirtualAuthenticator[];
  private created = 0;
  private readonly unplugged = new Set<number>();

  constructor(count: number, options: Partial<VirtualOptions> = {}) {
    this.keys = Array.from(
      { length: count },
      () => new VirtualAuthenticator({ origin: ORIGIN, ...options }),
    );
  }

  unplug(index: number): void {
    this.unplugged.add(index);
  }

  plug(index: number): void {
    this.unplugged.delete(index);
  }

  readonly container = {
    create: (request: CredentialCreationOptions) => {
      const key = this.keys[Math.min(this.created, this.keys.length - 1)];
      this.created += 1;
      if (!key) throw new Error("no key");
      return key.credentials.create(request);
    },
    get: async (request: CredentialRequestOptions) => {
      for (const [index, key] of this.keys.entries()) {
        if (this.unplugged.has(index)) continue;
        try {
          return await key.credentials.get(request);
        } catch (error) {
          if (error instanceof DOMException && error.name === "NotAllowedError")
            continue;
          throw error;
        }
      }
      throw new DOMException("no key answered", "NotAllowedError");
    },
  };

  ceremony(): Ceremony {
    return webauthnCeremony(asContainer(this.container));
  }
}

export type Person = {
  id: string;
  name: string;
  ring: KeyRing;
  ceremony: Ceremony;
  guardian: Guardian;
  secrets: GuardianSecrets;
  enrollment: Enrollment;
  holding?: Holding;
  receipt?: CustodyReceipt;
};

export type WorldOptions = {
  names: readonly string[];
  /** Keys per person; default 1. */
  keys?: Readonly<Record<string, number>>;
  keyOptions?: Readonly<Record<string, Partial<VirtualOptions>>>;
  groups: readonly {
    id: string;
    threshold: number;
    members: readonly string[];
  }[];
  groupThreshold?: number;
  operations?: readonly Operation[];
  approvalWindowSec?: number;
  releaseDelaySec?: number;
  requestLifetimeSec?: number;
  requireUserVerification?: boolean;
  custodyDomains?: Readonly<Record<string, string>>;
  payload?: Json;
  /** Stop before guardians accept their shares. */
  skipDelivery?: boolean;
};

export type World = {
  owner: OwnerKeys;
  circleId: string;
  people: Map<string, Person>;
  created: CreatedCircle;
  payload: Json;
};

export const PAYLOAD: Json = {
  items: [{ id: "bank", name: "Bank", secret: "correct horse battery staple" }],
};

async function enrollPeople(
  options: WorldOptions,
  invite: Invite,
): Promise<Map<string, Person>> {
  const people = new Map<string, Person>();
  for (const name of options.names) {
    const ring = new KeyRing(
      options.keys?.[name] ?? 1,
      options.keyOptions?.[name],
    );
    const ceremony = ring.ceremony();
    const { enrollment, secrets } = await enrollGuardian({
      invite,
      currentOrigin: ORIGIN,
      name,
      keyLabels: ring.keys.map((_, i) =>
        i === 0 ? "Security key" : "Backup key",
      ),
      ceremony,
      guardianId: `g-${name.toLowerCase()}`,
    });
    const guardian = await acceptEnrollment({
      invite,
      enrollment,
      custodyDomain:
        options.custodyDomains?.[name] ?? `home-${name.toLowerCase()}`,
      contactRef: `contact-${name.toLowerCase()}`,
      now: T0,
    });
    people.set(name, {
      id: guardian.id,
      name,
      ring,
      ceremony,
      guardian,
      secrets,
      enrollment,
    });
  }
  return people;
}

function draftFor(
  options: WorldOptions,
  circleId: string,
  people: ReadonlyMap<string, Person>,
): CircleDraft {
  const groups: Group[] = options.groups.map((g) => ({
    id: g.id,
    threshold: g.threshold,
    guardianIds: g.members.map((n) => people.get(n)?.id ?? n),
  }));
  return {
    circleId,
    label: "Family",
    collection: "Emergency",
    rpId: RP_ID,
    origins: [ORIGIN],
    guardians: [...people.values()].map((p) => p.guardian),
    groups,
    groupThreshold: options.groupThreshold ?? 1,
    operations: options.operations ?? ["recover-collection", "grant-access"],
    approvalWindowSec: options.approvalWindowSec ?? 600,
    releaseDelaySec: options.releaseDelaySec ?? 3600,
    requestLifetimeSec: options.requestLifetimeSec ?? 86400,
    requireUserVerification: options.requireUserVerification ?? true,
  };
}

async function deliverAll(
  world: Pick<World, "owner" | "created" | "people">,
): Promise<void> {
  for (const who of world.people.values()) {
    const accepted = await acceptDelivery({
      delivery: world.created.deliveries.find((d) => d.guardianId === who.id),
      signedPolicy: world.created.signedPolicy,
      pinnedOwnerKey: world.owner.publicKey,
      guardianId: who.id,
      hpkeSecretKey: who.secrets.hpkeSecretKey,
      ceremony: who.ceremony,
      credentialIds: who.guardian.credentials.map((c) => c.credentialId),
    });
    who.holding = accepted.holding;
    who.receipt = await verifyCustodyReceipt(
      world.created.signedPolicy,
      accepted.receipt,
    );
  }
}

export async function buildWorld(options: WorldOptions): Promise<World> {
  const owner = generateOwnerKeys();
  const circleId = newCircleId();
  const invite = createInvite({
    circleId,
    label: "Family",
    rpId: RP_ID,
    origins: [ORIGIN],
    ownerKey: owner.publicKey,
    requireUserVerification: options.requireUserVerification ?? true,
    now: T0,
  });
  const people = await enrollPeople(options, invite);
  const draft = draftFor(options, circleId, people);
  const payload = options.payload ?? PAYLOAD;
  const created = await createCircle({ draft, owner, payload, now: T0 });
  const world: World = { owner, circleId, people, created, payload };
  if (!options.skipDelivery && created.bundle) await deliverAll(world);
  return world;
}

export function holdingOf(who: Person): Holding {
  if (!who.holding) throw new Error(`${who.name} holds no share`);
  return who.holding;
}

export function person(world: World, name: string): Person {
  const found = world.people.get(name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

export const b64 = { to: toB64url, from: fromB64url };
