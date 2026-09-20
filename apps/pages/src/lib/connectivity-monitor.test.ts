/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Reachability = "reachable" | "unreachable";
type MonitorTestEnvironment = {
  identity: Reachability;
  settingsListeners: Set<() => void>;
  counts: { identity: number };
};

const env: MonitorTestEnvironment = {
  identity: "reachable",
  settingsListeners: new Set<() => void>(),
  counts: { identity: 0 },
};

import {
  DEGRADED_MS,
  HEALTHY_MS,
  STRIKES_TO_FAIL,
  checkNow,
  connectivityMonitorDependencies,
  connectivitySnapshot,
  resetConnectivityMonitorForTests,
  subscribeConnectivityMonitor,
} from "./connectivity-monitor.js";

Object.assign(connectivityMonitorDependencies, {
  identityBase: () => "http://127.0.0.1:18788",
  probeIdentityDetailed: async () => {
    env.counts.identity += 1;
    return {
      health: env.identity,
      failure: env.identity === "reachable" ? null : "unreachable",
    };
  },
  subscribeSettings: (cb: () => void) => {
    env.settingsListeners.add(cb);
    return () => env.settingsListeners.delete(cb);
  },
});

/** Let the in-flight probe promises settle without advancing fake timers. */
async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function watch() {
  return subscribeConnectivityMonitor(() => {});
}

beforeEach(() => {
  vi.useFakeTimers();
  env.identity = "reachable";
  env.counts = { identity: 0 };
  resetConnectivityMonitorForTests();
});

afterEach(() => {
  resetConnectivityMonitorForTests();
  vi.useRealTimers();
  env.settingsListeners.clear();
});

describe("subscription", () => {
  it("probes nothing until something is watching", async () => {
    await settle();
    expect(env.counts).toEqual({ identity: 0 });

    const off = watch();
    await settle();
    expect(env.counts.identity).toBe(1);
    off();
  });

  it("probes once per sweep however many components are watching", async () => {
    const offs = [watch(), watch(), watch(), watch(), watch(), watch()];
    await settle();
    // Six subscribers, one request — this is the whole point of the
    // supervisor: the old per-component effects made sixteen.
    expect(env.counts.identity).toBe(1);
    for (const off of offs) off();
  });

  it("stops scheduling once the last watcher goes away", async () => {
    const off = watch();
    await settle();
    off();
    expect(connectivitySnapshot().nextCheckAt).toBeNull();

    const before = env.counts.identity;
    await vi.advanceTimersByTimeAsync(HEALTHY_MS * 3);
    expect(env.counts.identity).toBe(before);
  });
});

describe("cadence", () => {
  it("checks rarely while everything is green", async () => {
    const off = watch();
    await settle();
    expect(env.counts.identity).toBe(1);

    // Well inside the healthy interval: still one.
    await vi.advanceTimersByTimeAsync(HEALTHY_MS * 0.5);
    expect(env.counts.identity).toBe(1);

    // Past it (plus the jitter ceiling): a second sweep has run.
    await vi.advanceTimersByTimeAsync(HEALTHY_MS * 0.7);
    expect(env.counts.identity).toBe(2);
    off();
  });

  it("tightens the moment something is not green", async () => {
    env.identity = "unreachable";
    const off = watch();
    await settle();

    const after = env.counts.identity;
    await vi.advanceTimersByTimeAsync(DEGRADED_MS * 1.3);
    expect(env.counts.identity).toBeGreaterThan(after);
    off();
  });

  it("schedules the confirming probe at the tight cadence, not the relaxed one", async () => {
    const off = watch();
    await settle();
    // Healthy: the next sweep is a long way off.
    const healthyGap = (connectivitySnapshot().nextCheckAt ?? 0) - Date.now();
    expect(healthyGap).toBeGreaterThan(DEGRADED_MS * 3);

    // The plane dies and takes its first strike. Hysteresis keeps the glyph
    // green for now — but the cadence must tighten immediately, or the probe
    // that confirms the outage waits a whole healthy interval. Reading the
    // damped health here instead of the strike is exactly that bug.
    env.identity = "unreachable";
    checkNow();
    await settle();
    expect(connectivitySnapshot().identity.health).toBe("reachable");

    const degradedGap = (connectivitySnapshot().nextCheckAt ?? 0) - Date.now();
    expect(degradedGap).toBeLessThan(DEGRADED_MS * 2);

    await vi.advanceTimersByTimeAsync(DEGRADED_MS * 1.3);
    expect(connectivitySnapshot().identity.health).toBe("unreachable");
    off();
  });

  it("backs off while it stays broken, and resets on recovery", async () => {
    env.identity = "unreachable";
    const off = watch();
    await settle();

    // Six degraded sweeps: with a fixed 5s cadence this window would hold far
    // more than the backoff ladder allows.
    await vi.advanceTimersByTimeAsync(60_000);
    const whileBroken = env.counts.identity;
    expect(whileBroken).toBeLessThan(12);

    env.identity = "reachable";
    checkNow();
    await settle();
    // Back to the relaxed cadence: a long window adds few sweeps.
    const afterRecovery = env.counts.identity;
    await vi.advanceTimersByTimeAsync(HEALTHY_MS * 1.5);
    expect(env.counts.identity - afterRecovery).toBeLessThanOrEqual(2);
    off();
  });
});

describe("hysteresis", () => {
  it("does not go amber on a single blip", async () => {
    const off = watch();
    await settle();
    expect(connectivitySnapshot().identity.health).toBe("reachable");

    env.identity = "unreachable";
    checkNow();
    await settle();
    // One strike is not an outage.
    expect(connectivitySnapshot().identity.health).toBe("reachable");

    checkNow();
    await settle();
    expect(connectivitySnapshot().identity.health).toBe("unreachable");
    expect(STRIKES_TO_FAIL).toBe(2);
    off();
  });

  it("reports the very first failure immediately, having nothing to protect", async () => {
    env.identity = "unreachable";
    const off = watch();
    await settle();
    expect(connectivitySnapshot().identity.health).toBe("unreachable");
    off();
  });

  it("restores green on the first success — good news is never damped", async () => {
    env.identity = "unreachable";
    const off = watch();
    await settle();
    expect(connectivitySnapshot().identity.health).toBe("unreachable");

    env.identity = "reachable";
    checkNow();
    await settle();
    expect(connectivitySnapshot().identity.health).toBe("reachable");
    off();
  });
});

describe("offline", () => {
  it("parks probing and says offline rather than blaming an endpoint", async () => {
    const off = watch();
    await settle();
    const before = env.counts.identity;

    window.dispatchEvent(new Event("offline"));
    await settle();
    expect(connectivitySnapshot().offline).toBe(true);
    expect(connectivitySnapshot().identity.failure).toBe("offline");
    expect(connectivitySnapshot().nextCheckAt).toBeNull();

    await vi.advanceTimersByTimeAsync(HEALTHY_MS * 3);
    expect(env.counts.identity).toBe(before);
    off();
  });

  it("drops the offline stamp when the radio comes back", async () => {
    env.identity = "unreachable";
    const off = watch();
    await settle();
    window.dispatchEvent(new Event("offline"));
    await settle();
    expect(connectivitySnapshot().identity.failure).toBe("offline");

    // Back online, before the triggered sweep has answered: we no longer know
    // why Identity is failing, and claiming "offline" would contradict the
    // amber tone the glyph still carries.
    window.dispatchEvent(new Event("online"));
    expect(connectivitySnapshot().offline).toBe(false);
    expect(connectivitySnapshot().identity.failure).not.toBe("offline");
    off();
  });

  it("checks immediately when the network comes back", async () => {
    const off = watch();
    await settle();
    window.dispatchEvent(new Event("offline"));
    await settle();
    const before = env.counts.identity;

    window.dispatchEvent(new Event("online"));
    await settle();
    expect(connectivitySnapshot().offline).toBe(false);
    expect(env.counts.identity).toBeGreaterThan(before);
    off();
  });
});

describe("settings", () => {
  it("re-checks when a base URL moves, because the old verdict is meaningless", async () => {
    const off = watch();
    await settle();
    const before = env.counts.identity;

    for (const listener of env.settingsListeners) listener();
    await settle();
    expect(env.counts.identity).toBeGreaterThan(before);
    off();
  });
});
