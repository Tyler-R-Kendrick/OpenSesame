/**
 * Live sessions live in `session.ts`, not in the capability module, so a
 * re-plan cannot drop a joiner — and so the module's disposal cannot end a
 * session either. What does end one, hosted or joined, is the plan ceasing
 * to approve `sharing.live` (ADR 0150 §7): the operator prohibits it, or the
 * person switches it off. Both directions are pinned here, against plans the
 * real resolver made.
 */

import type { EffectivePlan } from "@opensesame/capability-composition";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeNet } from "./live-fakes.js";
import { plan } from "./live-plan.fixture.js";
import type { Carrier, CarrierFactory } from "./rendezvous.js";
import {
  currentGuest,
  currentHost,
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

/** The composition store publishing `next` to whoever listens. */
function publish(next: EffectivePlan | null): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

/** Let carriers still deriving their topic (WebCrypto) open, or be closed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

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
  return startHosting({
    title: "Team",
    scope: { kind: "vault" },
    policy: "read",
    admission: "invite",
    minutes: 5,
    transport: net.transports(),
    routes: transport,
    carriers,
  });
}

async function join() {
  const hosted = await host();
  const guest = await joinLive({
    link: hosted.link,
    code: null,
    name: "Ada",
    note: "",
    transport: net.transports(),
    useRoutes: true,
    carriers,
  });
  return { hosted, guest };
}

beforeEach(() => {
  net = new FakeNet();
  opened = 0;
  closed = 0;
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
  await settle();
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
    await settle();
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
    await settle();
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
    await settle();
    expect(hosted.state.status).toBe("ended");
    expect(currentHost()).toBeNull();
    expect(opened).toBe(0);
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
      transport: net.transports(),
      useRoutes: true,
      carriers,
    });
    await settle();
    expect(currentGuest()).toBeNull();
    expect(currentHost()).toBeNull();
    expect(guest.status.at).not.toBe("request");
    expect(listeners.size).toBe(0);
  });
});

describe("a re-plan that still approves it drops nobody", () => {
  it("keeps both sessions through a lock, an unlock and a consent commit", async () => {
    const { hosted, guest } = await join();
    await settle();
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
