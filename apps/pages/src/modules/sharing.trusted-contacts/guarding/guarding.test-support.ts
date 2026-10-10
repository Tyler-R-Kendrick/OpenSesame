/**
 * What the guardian sheets' tests stand on: the desk tests' in-memory people,
 * a way to see what a Copy key put on the clipboard, and circles stopped at
 * each point a guardian meets them (an invitation, a welcome, a notice, a
 * request). What passes between people is a packet string, as it would be
 * pasted.
 */

import type { Ceremony } from "@opensesame/app-core/lib/quorum/ceremony.js";
import {
  type Armed,
  Clock,
  type Device,
  armedCircle,
  device,
  oneGroup,
  who,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  DEFAULT_TIMING,
  acceptGuardian,
  acceptInvitation,
  beginCircle,
  createFromDraft,
  inviteMore,
  reissue,
  startRecoveryFlow,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { PAYLOAD } from "@opensesame/app-core/lib/quorum/world.test-support.js";
import { isJsonObject, isString } from "@opensesame/os-domain";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import type { Desk } from "../use-desk.js";

const original = { ...vaultHooksSeams };

/** Make every Copy key write to `copied` until `restoreCopies` runs. */
export function captureCopies(): string[] {
  const copied: string[] = [];
  Object.assign(vaultHooksSeams, {
    useCopySecret: () => async (value: string) => {
      copied.push(value);
      return "copied" as const;
    },
  });
  return copied;
}

export function restoreCopies(): void {
  Object.assign(vaultHooksSeams, original);
}

/**
 * The same person with a security key that is dismissed until `allow` runs:
 * the browser's own refusal when a prompt is cancelled or times out. A plain
 * `Error` named as the browser names it, because jsdom's `DOMException` is
 * not an `Error` and a real browser's is.
 */
export type Dismissable = Readonly<{ person: Device; allow: () => void }>;

export function dismissable(person: Device): Dismissable {
  let dismissed = true;
  const ceremony: Ceremony = {
    register: async (input) => person.ceremony.register(input),
    assert: async (input) => {
      if (dismissed) {
        throw Object.assign(new Error("dismissed"), {
          name: "NotAllowedError",
        });
      }
      return person.ceremony.assert(input);
    },
  };
  return {
    person: { ...person, ceremony },
    allow: () => {
      dismissed = false;
    },
  };
}

/** An owner's invitation to a circle, and the owner who made it. */
export async function invitation(clock: Clock, recovers = true) {
  const owner = device(clock);
  const begun = await beginCircle(owner, {
    label: "Family",
    collection: "Emergency",
    recovers,
  });
  return { owner, invite: begun.invite, circleId: begun.draft.circleId };
}

/**
 * A circle made but not yet taken: three people have each agreed, the owner
 * has dealt, and Ada's device holds an agreement and the welcome meant for it.
 */
export async function dealtCircle(clock: Clock, recovers = true) {
  const owner = device(clock);
  const { draft, invite } = await beginCircle(owner, {
    label: "Family",
    collection: "Emergency",
    recovers,
  });
  const people = new Map<string, Device>(
    ["Ada", "Ben", "Cy"].map((name) => [name, device(clock)]),
  );
  const ids: string[] = [];
  for (const [name, person] of people) {
    const { enrollment } = await acceptInvitation(person, {
      packet: invite,
      name,
      keyLabels: ["Security key"],
    });
    const guardian = await acceptGuardian(owner, draft.circleId, {
      packet: enrollment,
      custodyDomain: `home-${name}`,
      contactRef: null,
    });
    ids.push(guardian.id);
  }
  const dealt = await createFromDraft(owner, draft.circleId, {
    rule: oneGroup(ids, 2),
    timing: DEFAULT_TIMING,
    payload: recovers ? PAYLOAD : undefined,
  });
  const ada = people.get("Ada");
  const welcome = dealt.welcomes.find((one) => one.name === "Ada");
  if (!ada || !welcome) throw new Error("no welcome for Ada");
  return {
    owner,
    ada,
    circleId: draft.circleId,
    welcome: welcome.packet,
    dealt,
  };
}

/** A circle armed, with Cy replaced by Dee at a second epoch: Cy's notice and Ada's. */
export async function replacedCircle(clock: Clock) {
  const armed = await armedCircle(clock);
  const dee = device(clock);
  const { invite } = await inviteMore(armed.owner, armed.circleId);
  const { enrollment } = await acceptInvitation(dee, {
    packet: invite,
    name: "Dee",
    keyLabels: ["Security key"],
  });
  const guardian = await acceptGuardian(armed.owner, armed.circleId, {
    packet: enrollment,
    custodyDomain: "home-Dee",
    contactRef: null,
  });
  const [ada, ben, cy] = armed.guardianIds;
  if (!ada || !ben || !cy) throw new Error("no guardians");
  clock.at(3600);
  const dealt = await reissue(armed.owner, armed.circleId, {
    drop: [cy],
    rule: oneGroup([ada, ben, guardian.id], 2),
    payload: PAYLOAD,
  });
  const notice = dealt.notices[0];
  if (!notice) throw new Error("no notice for Cy");
  return { armed, dealt, notice: notice.packet };
}

/** An armed circle and a request to recover it, raised by a new device. */
export async function recovering(clock: Clock) {
  const armed: Armed = await armedCircle(clock);
  const recipient = device(clock);
  const started = await startRecoveryFlow(recipient, {
    bundleText: armed.dealt.bundleFile ?? "",
    recipientLabel: "New laptop",
  });
  return { armed, recipient, started };
}

export { who };

/** A desk that reads its records again when refreshed, as the page's does when the vault changes. */
export async function liveDesk(person: Device): Promise<Desk> {
  let held = await person.records.held();
  return {
    ports: person,
    owned: [],
    get held() {
      return held;
    },
    refresh: async () => {
      held = await person.records.held();
    },
  };
}

export const WAITING = "Waiting for what the owner sends";

/** A guardian who has agreed to Family's invitation and been answered by nobody. */
export async function agreedGuardian() {
  const clock = new Clock();
  const { invite, circleId } = await invitation(clock);
  const guardian = device(clock);
  await acceptInvitation(guardian, {
    packet: invite,
    name: "Ada",
    keyLabels: ["Security key"],
  });
  return { clock, guardian, circleId, invite };
}

/** The receiving key the desk sealed for an agreement: the one secret that must never be drawn. */
export async function receivingKeyOf(guardian: Device): Promise<string> {
  const [key] = await guardian.pending.list("guardian-pending:");
  const doc = key === undefined ? undefined : await guardian.pending.read(key);
  if (isJsonObject(doc) && isString(doc.hpkeSecretKey))
    return doc.hpkeSecretKey;
  throw new Error("no agreement kept");
}
