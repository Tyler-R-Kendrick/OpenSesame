/**
 * A network policy that changes under a running session reaches its carriers
 * (ADR 0150 §7). A socket stays open until someone closes it, so the session
 * holds each carrier to the plan again on every re-plan: one the new policy
 * does not allow is closed and shown as blocked, while the session, whose
 * capability is still approved, goes on, and so does a carrier the policy
 * still allows.
 */

import type { EffectivePlan } from "@opensesame/capability-composition";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeNet } from "./live-fakes.js";
import { plan } from "./live-plan.fixture.js";
import { type Carrier, type CarrierFactory, Rendezvous } from "./rendezvous.js";
import {
  currentHost,
  currentHostCarriers,
  endHosting,
  leaveLive,
  liveSeams,
  startHosting,
} from "./session.js";
import type { CarrierSpec, LiveTransport } from "./transport.js";

const RELAY = "wss://relay.example.com";
const NTFY = "https://ntfy.example.com";

const allow = (...origins: string[]): EffectivePlan["network"] => ({
  externalServices: "allow",
  allowedServiceOrigins: origins,
});
const deny: EffectivePlan["network"] = {
  externalServices: "deny",
  allowedServiceOrigins: [],
};

const originalSeams = { ...liveSeams };
let current: EffectivePlan | null = null;
const listeners = new Set<() => void>();
let net: FakeNet;
let opened: string[] = [];
let closed: string[] = [];
let attempts: Promise<Carrier>[] = [];

function publish(next: EffectivePlan): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

/** Observe the real guarded opening promise returned to Rendezvous. */
function observeAttempts(): void {
  const open = Rendezvous.open;
  vi.spyOn(Rendezvous, "open").mockImplementation(
    (specs, secret, factory, onCode, role) =>
      open(
        specs,
        secret,
        (...args) => {
          const attempt = factory(...args);
          attempts.push(attempt);
          return attempt;
        },
        onCode,
        role,
      ),
  );
}

function attempt(): Promise<Carrier> {
  const opening = attempts.at(-1);
  if (!opening)
    throw new Error("The actual carrier factory has not been invoked");
  return opening;
}

/** The real state subscription fires immediately too; dispose in either case. */
function allCarriersReady(): Promise<void> {
  const rendezvous = currentHostCarriers();
  if (!rendezvous) throw new Error("The host has no rendezvous");
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

const carriers: CarrierFactory = async (spec: CarrierSpec) => {
  const name = spec.kind === "broadcast" ? "broadcast" : spec.url;
  opened.push(name);
  const carrier: Carrier = {
    post: async () => {},
    listen: () => () => {},
    close: () => {
      closed.push(name);
    },
  };
  return carrier;
};

async function host(specs: CarrierSpec[]) {
  const transport: LiveTransport = {
    addresses: [],
    ice: [],
    relay: false,
    carriers: specs,
  };
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
  await allCarriersReady();
  return hosted;
}

const statuses = () =>
  currentHostCarriers()?.states.map((state) => state.status) ?? [];

beforeEach(() => {
  net = new FakeNet();
  opened = [];
  closed = [];
  attempts = [];
  observeAttempts();
  current = plan(true, false, allow());
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
  await Promise.allSettled(attempts);
  vi.restoreAllMocks();
  Object.assign(liveSeams, originalSeams);
});

describe("a policy that changes under a running session", () => {
  it("closes a socket carrier when external services are denied, and the session goes on", async () => {
    const hosted = await host([{ kind: "nostr", url: RELAY }]);
    expect(opened).toEqual([RELAY]);
    expect(statuses()).toEqual(["ready"]);
    publish(plan(true, false, deny));
    expect(closed).toEqual([RELAY]);
    expect(statuses()).toEqual(["blocked"]);
    expect(currentHost()).toBe(hosted);
    expect(hosted.state.status).toBe("live");
  });

  it("closes it when its origin leaves the operator's list", async () => {
    await host([{ kind: "mqtt", url: RELAY }]);
    publish(plan(true, false, allow(RELAY)));
    expect(closed).toEqual([]);
    publish(plan(true, false, allow("wss://other.example.com")));
    expect(closed).toEqual([RELAY]);
    expect(statuses()).toEqual(["blocked"]);
  });

  it("closes only the carriers the policy no longer allows", async () => {
    await host([
      { kind: "nostr", url: RELAY },
      { kind: "nats", url: "wss://nats.example.com" },
      { kind: "broadcast", url: "" },
    ]);
    publish(plan(true, false, allow(RELAY)));
    expect(closed).toEqual(["wss://nats.example.com"]);
    expect(statuses()).toEqual(["ready", "blocked", "ready"]);
  });

  it("closes an ntfy stream the policy no longer allows, and leaves BroadcastChannel", async () => {
    await host([
      { kind: "ntfy", url: NTFY },
      { kind: "broadcast", url: "" },
    ]);
    publish(plan(true, false, deny));
    expect(closed).toEqual([NTFY]);
    expect(statuses()).toEqual(["blocked", "ready"]);
  });

  it("does not turn a refused carrier's later failure into a connection fault", async () => {
    const invoked = signal();
    let fail: (reason: Error) => void = () => {};
    const failing: CarrierFactory = () =>
      new Promise((_resolve, reject) => {
        fail = reject;
        invoked.resolve();
      });
    await startHosting({
      title: "Team",
      scope: { kind: "vault" },
      policy: "read",
      admission: "invite",
      minutes: 5,
      peers: net.factory(),
      transport: {
        addresses: [],
        ice: [],
        relay: false,
        carriers: [{ kind: "nostr", url: RELAY }],
      },
      carriers: failing,
    });
    try {
      await invoked.promise;
      publish(plan(true, false, deny));
      expect(statuses()).toEqual(["blocked"]);
      fail(new Error("socket closed"));
      // Rendezvous attached its real rejection handler before this await.
      await expect(attempt()).rejects.toThrow("socket closed");
      expect(statuses()).toEqual(["blocked"]);
    } finally {
      fail(new Error("socket closed"));
    }
  });

  it("does not reopen a closed carrier when the policy allows it again", async () => {
    await host([{ kind: "nostr", url: RELAY }]);
    publish(plan(true, false, deny));
    publish(plan(true, false, allow()));
    await Promise.allSettled(attempts);
    expect(opened).toEqual([RELAY]);
    expect(statuses()).toEqual(["blocked"]);
  });

  it("closes one that arrives after the policy withdrew it", async () => {
    const invoked = signal();
    const closure = signal();
    let released = false;
    let release: (carrier: Carrier) => void = () => {};
    const slow: CarrierFactory = (spec) =>
      new Promise((resolve) => {
        release = (carrier) => {
          if (released) return;
          released = true;
          opened.push(spec.kind === "broadcast" ? "broadcast" : spec.url);
          resolve(carrier);
        };
        invoked.resolve();
      });
    const transport: LiveTransport = {
      addresses: [],
      ice: [],
      relay: false,
      carriers: [{ kind: "nostr", url: RELAY }],
    };
    await startHosting({
      title: "Team",
      scope: { kind: "vault" },
      policy: "read",
      admission: "invite",
      minutes: 5,
      peers: net.factory(),
      transport,
      carriers: slow,
    });
    const late: Carrier = {
      post: async () => {},
      listen: () => () => {},
      close: () => {
        closed.push(RELAY);
        closure.resolve();
      },
    };
    try {
      await invoked.promise;
      expect(statuses()).toEqual(["connecting"]);
      publish(plan(true, false, deny));
      expect(statuses()).toEqual(["blocked"]);
      release(late);
      await attempt();
      await closure.promise;
      expect(closed).toEqual([RELAY]);
      expect(statuses()).toEqual(["blocked"]);
    } finally {
      release(late);
    }
  });
});
