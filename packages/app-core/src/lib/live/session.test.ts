/**
 * Live sessions live in `session.ts`, not in the capability module, so a
 * re-plan cannot drop a joiner — and so the module's disposal cannot end a
 * session either. What does end one, hosted or joined, is the plan ceasing
 * to approve `sharing.live` (ADR 0150 §7): the operator prohibits it, or the
 * person switches it off. Both directions are pinned here, against plans the
 * real resolver made.
 */

import type { EffectivePlan } from "@opensesame/capability-composition";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeNet } from "./live-fakes.js";
import { plan } from "./live-plan.fixture.js";
import { type Carrier, type CarrierFactory, Rendezvous } from "./rendezvous.js";
import {
  currentGuest,
  currentGuestCarriers,
  currentHost,
  currentHostCarriers,
  endHosting,
  joinLive,
  leaveLive,
  liveSeams,
  planApprovesLive,
  startHosting,
} from "./session.js";
import type { LiveTransport } from "./transport.js";

const originalSeams = { ...liveSeams };
let current: EffectivePlan | null = null;
const listeners = new Set<() => void>();
let net: FakeNet;
let opened = 0;
let closed = 0;
type Opening = { invoked: Promise<void>; attempts: Promise<Carrier>[] };
let openings: Opening[] = [];

/** The composition store publishing `next` to whoever listens. */
function publish(next: EffectivePlan | null): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

/** Observe topic completion through each actual guarded factory invocation. */
function observeOpenings(): void {
  const open = Rendezvous.open;
  vi.spyOn(Rendezvous, "open").mockImplementation(
    (specs, secret, factory, onCode, role) => {
      let invoked = () => {};
      let remaining = specs.length;
      const opening: Opening = {
        invoked: new Promise<void>((resolve) => {
          invoked = resolve;
        }),
        attempts: [],
      };
      openings.push(opening);
      if (remaining === 0) invoked();
      return open(
        specs,
        secret,
        (...args) => {
          const attempt = factory(...args);
          opening.attempts.push(attempt);
          remaining -= 1;
          if (remaining === 0) invoked();
          return attempt;
        },
        onCode,
        role,
      );
    },
  );
}

/** Topic work may still be pending after an already-ended join returns. */
async function drainOpenings(): Promise<void> {
  for (const opening of openings) {
    await opening.invoked;
    // Rendezvous attached its real ready/failure reaction before this await.
    await Promise.allSettled(opening.attempts);
  }
}

/** Positive hosting/joining waits for a nonempty real all-ready state. */
function allCarriersReady(rendezvous: Rendezvous | null): Promise<void> {
  if (!rendezvous || rendezvous.states.length === 0)
    throw new Error("Expected the session's broadcast rendezvous");
  return new Promise((resolve) => {
    let stop = () => {};
    let ready = false;
    stop = rendezvous.subscribe((states) => {
      if (!states.every((state) => state.status === "ready")) return;
      ready = true;
      stop();
      resolve();
    });
    if (ready) stop();
  });
}

const carriers: CarrierFactory = async () => {
  opened += 1;
  const carrier: Carrier = {
    post: async () => {},
    listen: () => () => {},
    close: () => {
      closed += 1;
    },
  };
  return carrier;
};

const transport: LiveTransport = {
  addresses: [],
  ice: [],
  relay: false,
  carriers: [{ kind: "broadcast", url: "" }],
};

async function host() {
  const hosted = await startHosting({
    title: "Team",
    scope: { kind: "vault" },
    policy: "read",
    admission: "invite",
    minutes: 5,
    peers: net.factory(),
    transport,
    carriers,
  });
  if (currentHost() === hosted) await allCarriersReady(currentHostCarriers());
  await drainOpenings();
  return hosted;
}

async function join() {
  const hosted = await host();
  const guest = await joinLive({
    link: hosted.link,
    code: null,
    name: "Ada",
    note: "",
    peers: net.factory(),
    useRoutes: true,
    carriers,
  });
  if (currentGuest() === guest) await allCarriersReady(currentGuestCarriers());
  await drainOpenings();
  return { hosted, guest };
}

beforeEach(() => {
  net = new FakeNet();
  opened = 0;
  closed = 0;
  openings = [];
  observeOpenings();
  current = plan(true);
  listeners.clear();
  Object.assign(liveSeams, {
    items: () => [],
    onLock: () => () => {},
    plan: () => current,
    onPlan: (handler: () => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  });
});

afterEach(async () => {
  leaveLive();
  endHosting();
  await drainOpenings();
  vi.restoreAllMocks();
  Object.assign(liveSeams, originalSeams);
});

describe("planApprovesLive", () => {
  it("reads the resolver's own verdict", () => {
    expect(planApprovesLive(plan(true))).toBe(true);
    expect(planApprovesLive(plan(false))).toBe(false);
    expect(planApprovesLive(plan(true, true))).toBe(false);
  });
});

describe("withdrawing Live sessions ends what is running", () => {
  it("ends a hosted session, its carriers and its peer, when the person switches it off", async () => {
    const hosted = await host();
    await drainOpenings();
    expect(opened).toBe(1);
    expect(currentHost()).toBe(hosted);
    expect(listeners.size).toBe(1);
    publish(plan(false));
    expect(currentHost()).toBeNull();
    expect(hosted.state.status).toBe("ended");
    expect(closed).toBe(opened);
    expect(listeners.size).toBe(0);
  });

  it("ends a joined session and its carriers when the operator prohibits it", async () => {
    const { hosted, guest } = await join();
    await drainOpenings();
    expect(currentGuest()).toBe(guest);
    expect(opened).toBe(2);
    publish(plan(true, true));
    expect(currentGuest()).toBeNull();
    expect(currentHost()).toBeNull();
    expect(hosted.state.status).toBe("ended");
    expect(closed).toBe(2);
    expect(listeners.size).toBe(0);
  });

  it("does nothing on a plan that is not resolved yet", async () => {
    await join();
    publish(null);
    expect(currentHost()).not.toBeNull();
    expect(currentGuest()).not.toBeNull();
  });
});

describe("a session started after the plan withdrew Live sessions", () => {
  it("never stands: a host comes back ended and is not the current one", async () => {
    current = plan(false);
    const hosted = await host();
    await drainOpenings();
    expect(hosted.state.status).toBe("ended");
    expect(currentHost()).toBeNull();
    expect(opened).toBe(0);
    expect(openings).toHaveLength(0);
    expect(listeners.size).toBe(0);
  });

  it("never stands: a joiner is left before it asks", async () => {
    const hosted = await host();
    current = plan(false);
    const guest = await joinLive({
      link: hosted.link,
      code: null,
      name: "Ada",
      note: "",
      peers: net.factory(),
      useRoutes: true,
      carriers,
    });
    await drainOpenings();
    expect(currentGuest()).toBeNull();
    expect(currentHost()).toBeNull();
    expect(guest.status.at).not.toBe("request");
    expect(closed).toBe(opened);
    expect(listeners.size).toBe(0);
  });
});

describe("a re-plan that still approves it drops nobody", () => {
  it("keeps both sessions through a lock, an unlock and a consent commit", async () => {
    const { hosted, guest } = await join();
    await drainOpenings();
    // A lock, an unlock and a consent commit each publish a new plan; so does
    // every activity note the store makes between them.
    publish(plan(true));
    publish(null);
    publish(plan(true));
    publish(plan(true));
    expect(currentHost()).toBe(hosted);
    expect(currentGuest()).toBe(guest);
    expect(hosted.state.status).toBe("live");
    expect(closed).toBe(0);
    expect(listeners.size).toBe(1);
  });

  it("stops watching once nothing is running", async () => {
    const { hosted } = await join();
    leaveLive();
    expect(listeners.size).toBe(1);
    endHosting();
    expect(listeners.size).toBe(0);
    expect(hosted.state.status).toBe("ended");
  });
});
