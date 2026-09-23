/** @vitest-environment jsdom */
/**
 * Contribution registry: generation fencing. A stale, unbound, or
 * unapproved lease cannot register; a bump hides every older entry before
 * anything disposes it; entries come back sorted by order, then id.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  contributionsSnapshot,
  subscribeContributions,
} from "../contributions.js";
import {
  bootPersonalLocal,
  draftFor,
  freshRealm,
} from "./__tests__/harness.js";
import { deriveLease } from "./lease.js";
import {
  bindLeaseToCapability,
  contributions,
  registerContribution,
  revokeGeneration,
} from "./registry.js";
import { compositionStore } from "./store.js";

const PASSKEYS = "vault.passkey-records";

function route(id: string, order: number) {
  return { id, path: `/${id}`, element: () => null, framed: true, order };
}

beforeEach(freshRealm);

describe("the synchronous face (lib/contributions.ts)", () => {
  it("notifies a non-React subscriber when a capability registers", async () => {
    // The WebMCP surface is the caller that matters: it re-reads the tool
    // table on change, and its doc says "approving or disabling another
    // capability mid-session is reflected without a reload". This
    // subscription used to reach only the test-injection channel, so in
    // production it never fired — the surface held whatever snapshot
    // existed when it mounted, and eight wallet session tools that
    // registered a moment later never reached the browser at all.
    await bootPersonalLocal();
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
    await compositionStore.commit(draft, receipt);
    const child = deriveLease(compositionStore.currentLease());
    bindLeaseToCapability(child.lease, PASSKEYS);

    let notifications = 0;
    const stop = subscribeContributions(() => {
      notifications += 1;
    });
    try {
      expect(contributionsSnapshot("route")).toHaveLength(0);
      const handle = registerContribution("route", route("a", 1), child.lease);
      expect(notifications).toBeGreaterThan(0);
      expect(contributionsSnapshot("route").map((r) => r.id)).toEqual(["a"]);

      const before = notifications;
      handle.revoke();
      expect(notifications).toBeGreaterThan(before);
      expect(contributionsSnapshot("route")).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("stops notifying once the subscriber unsubscribes", async () => {
    await bootPersonalLocal();
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
    await compositionStore.commit(draft, receipt);
    const child = deriveLease(compositionStore.currentLease());
    bindLeaseToCapability(child.lease, PASSKEYS);

    let notifications = 0;
    subscribeContributions(() => {
      notifications += 1;
    })();
    registerContribution("route", route("a", 1), child.lease);
    expect(notifications).toBe(0);
  });
});

describe("registerContribution", () => {
  it("refuses an unbound lease", async () => {
    await bootPersonalLocal();
    const lease = compositionStore.currentLease();
    expect(() => registerContribution("route", route("a", 1), lease)).toThrow(
      /LEASE_UNBOUND/,
    );
  });

  it("refuses a lease bound to an unapproved capability", async () => {
    await bootPersonalLocal();
    const child = deriveLease(compositionStore.currentLease());
    bindLeaseToCapability(child.lease, PASSKEYS);
    expect(() =>
      registerContribution("route", route("a", 1), child.lease),
    ).toThrow(/NOT_APPROVED/);
  });

  it("refuses a stale lease and hides older entries after a bump", async () => {
    await bootPersonalLocal();
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
    await compositionStore.commit(draft, receipt);
    const child = deriveLease(compositionStore.currentLease());
    bindLeaseToCapability(child.lease, PASSKEYS);
    const handle = registerContribution("route", route("b", 2), child.lease);
    registerContribution("route", route("a", 2), child.lease);
    registerContribution("route", route("c", 1), child.lease);
    expect(contributions("route").map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(handle.capability).toBe(PASSKEYS);

    compositionStore.invalidate("test");

    // Fenced before anything disposed: the entries are simply not current.
    expect(contributions("route")).toEqual([]);
    expect(() =>
      registerContribution("route", route("d", 1), child.lease),
    ).toThrow(/STALE_LEASE/);
    revokeGeneration(handle.generation);
    expect(contributions("route")).toEqual([]);
  });

  it("revoke is idempotent and the snapshot is referentially stable", async () => {
    await bootPersonalLocal();
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
    await compositionStore.commit(draft, receipt);
    const child = deriveLease(compositionStore.currentLease());
    bindLeaseToCapability(child.lease, PASSKEYS);
    const handle = registerContribution(
      "command-path",
      { path: "/x", label: "X" },
      child.lease,
    );
    const first = contributions("command-path");
    expect(contributions("command-path")).toBe(first);
    handle.revoke();
    handle.revoke();
    expect(contributions("command-path")).toEqual([]);
  });
});
