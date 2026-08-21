/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Reachability = "reachable" | "unreachable";
type MonitorTestEnvironment = {
  host: Reachability;
  identity: Reachability;
  hostFailure: string | null;
  daemonApi: string;
  daemonOk: boolean;
  daemonError: Error | null;
  loopbackPage: boolean;
  settingsListeners: Set<() => void>;
  counts: { host: number; identity: number; daemon: number };
};

const env: MonitorTestEnvironment = {
  host: "reachable",
  identity: "reachable",
  hostFailure: null,
  daemonApi: "http://127.0.0.1:18790",
  daemonOk: true,
  daemonError: null,
  loopbackPage: true,
  settingsListeners: new Set<() => void>(),
  counts: { host: 0, identity: 0, daemon: 0 },
};

import {
  connectivityMonitorDependencies,
  DEGRADED_MS,
  HEALTHY_MS,
  STRIKES_TO_FAIL,
  checkNow,
  connectivitySnapshot,
  daemonIsProbable,
  resetConnectivityMonitorForTests,
  subscribeConnectivityMonitor,
} from "./connectivity-monitor.js";

Object.assign(connectivityMonitorDependencies, {
  hostBase: () => "http://127.0.0.1:18787",
  identityBase: () => "http://127.0.0.1:18788",
  probeHostDetailed: async () => {
    env.counts.host += 1;
    return {
      health: env.host,
      failure:
        env.host === "reachable" ? null : (env.hostFailure ?? "unreachable"),
    };
  },
  probeIdentityDetailed: async () => {
    env.counts.identity += 1;
    return {
      health: env.identity,
      failure: env.identity === "reachable" ? null : "unreachable",
    };
  },
  probeDaemon: async () => {
    env.counts.daemon += 1;
    if (env.daemonError) throw env.daemonError;
    return {
      status: "ok",
      service: env.daemonOk ? "opensesame-daemon" : "something-else",
      hostApi: "",
      identityApi: "",
      tailscaleUrl: null,
    };
  },
  loadSettings: () => ({ daemonApi: env.daemonApi }),
  pageIsLoopback: () => env.loopbackPage,
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
  env.host = "reachable";
  env.identity = "reachable";
  env.hostFailure = null;
  env.daemonApi = "http://127.0.0.1:18790";
  env.daemonOk = true;
  env.daemonError = null;
  env.loopbackPage = true;
  env.counts = { host: 0, identity: 0, daemon: 0 };
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
    expect(env.counts).toEqual({ host: 0, identity: 0, daemon: 0 });

    const off = watch();
    await settle();
    expect(env.counts.host).toBe(1);
    off();
  });

  it("probes once per sweep however many components are watching", async () => {
    const offs = [watch(), watch(), watch(), watch(), watch(), watch()];
    await settle();
    // Six subscribers, one request each — this is the whole point of the
    // supervisor: the old per-component effects made sixteen.
    expect(env.counts.host).toBe(1);
    expect(env.counts.identity).toBe(1);
    expect(env.counts.daemon).toBe(1);
    for (const off of offs) off();
  });

  it("stops scheduling once the last watcher goes away", async () => {
    const off = watch();
    await settle();
    off();
    expect(connectivitySnapshot().nextCheckAt).toBeNull();

    const before = env.counts.host;
    await vi.advanceTimersByTimeAsync(HEALTHY_MS * 3);
    expect(env.counts.host).toBe(before);
  });
});

describe("cadence", () => {
  it("checks rarely while everything is green", async () => {
    const off = watch();
    await settle();
    expect(env.counts.host).toBe(1);

    // Well inside the healthy interval: still one.
    await vi.advanceTimersByTimeAsync(HEALTHY_MS * 0.5);
    expect(env.counts.host).toBe(1);

    // Past it (plus the jitter ceiling): a second sweep has run.
    await vi.advanceTimersByTimeAsync(HEALTHY_MS * 0.7);
    expect(env.counts.host).toBe(2);
    off();
  });

  it("tightens the moment something is not green", async () => {
    env.host = "unreachable";
    const off = watch();
    await settle();

    const after = env.counts.host;
    await vi.advanceTimersByTimeAsync(DEGRADED_MS * 1.3);
    expect(env.counts.host).toBeGreaterThan(after);
    off();
  });

  it("schedules the confirming probe at the tight cadence, not the relaxed one", async () => {
    const off = watch();
    await settle();
    // Healthy: the next sweep is a long way off.
    const healthyGap = (connectivitySnapshot().nextCheckAt ?? 0) - Date.now();
    expect(healthyGap).toBeGreaterThan(DEGRADED_MS * 3);

    // A plane dies and takes its first strike. Hysteresis keeps the glyph
    // green for now — but the cadence must tighten immediately, or the probe
    // that confirms the outage waits a whole healthy interval. Reading the
    // damped health here instead of the strike is exactly that bug.
    env.host = "unreachable";
    checkNow();
    await settle();
    expect(connectivitySnapshot().host.health).toBe("reachable");

    const degradedGap = (connectivitySnapshot().nextCheckAt ?? 0) - Date.now();
    expect(degradedGap).toBeLessThan(DEGRADED_MS * 2);

    await vi.advanceTimersByTimeAsync(DEGRADED_MS * 1.3);
    expect(connectivitySnapshot().host.health).toBe("unreachable");
    off();
  });

  it("backs off while it stays broken, and resets on recovery", async () => {
    env.host = "unreachable";
    const off = watch();
    await settle();

    // Six degraded sweeps: with a fixed 5s cadence this window would hold far
    // more than the backoff ladder allows.
    await vi.advanceTimersByTimeAsync(60_000);
    const whileBroken = env.counts.host;
    expect(whileBroken).toBeLessThan(12);

    env.host = "reachable";
    checkNow();
    await settle();
    // Back to the relaxed cadence: a long window adds few sweeps.
    const afterRecovery = env.counts.host;
    await vi.advanceTimersByTimeAsync(HEALTHY_MS * 1.5);
    expect(env.counts.host - afterRecovery).toBeLessThanOrEqual(2);
    off();
  });
});

describe("hysteresis", () => {
  it("does not go amber on a single blip", async () => {
    const off = watch();
    await settle();
    expect(connectivitySnapshot().host.health).toBe("reachable");

    env.host = "unreachable";
    checkNow();
    await settle();
    // One strike is not an outage.
    expect(connectivitySnapshot().host.health).toBe("reachable");

    checkNow();
    await settle();
    expect(connectivitySnapshot().host.health).toBe("unreachable");
    expect(STRIKES_TO_FAIL).toBe(2);
    off();
  });

  it("reports the very first failure immediately, having nothing to protect", async () => {
    env.host = "unreachable";
    const off = watch();
    await settle();
    expect(connectivitySnapshot().host.health).toBe("unreachable");
    off();
  });

  it("restores green on the first success — good news is never damped", async () => {
    env.host = "unreachable";
    const off = watch();
    await settle();
    expect(connectivitySnapshot().host.health).toBe("unreachable");

    env.host = "reachable";
    checkNow();
    await settle();
    expect(connectivitySnapshot().host.health).toBe("reachable");
    off();
  });
});

describe("offline", () => {
  it("parks probing and says offline rather than blaming an endpoint", async () => {
    const off = watch();
    await settle();
    const before = env.counts.host;

    window.dispatchEvent(new Event("offline"));
    await settle();
    expect(connectivitySnapshot().offline).toBe(true);
    expect(connectivitySnapshot().host.failure).toBe("offline");
    expect(connectivitySnapshot().nextCheckAt).toBeNull();

    await vi.advanceTimersByTimeAsync(HEALTHY_MS * 3);
    expect(env.counts.host).toBe(before);
    off();
  });

  it("drops the offline stamp when the radio comes back", async () => {
    env.host = "unreachable";
    const off = watch();
    await settle();
    window.dispatchEvent(new Event("offline"));
    await settle();
    expect(connectivitySnapshot().host.failure).toBe("offline");

    // Back online, before the triggered sweep has answered: we no longer know
    // why Host is failing, and claiming "offline" would contradict the amber
    // tone the glyph still carries.
    window.dispatchEvent(new Event("online"));
    expect(connectivitySnapshot().offline).toBe(false);
    expect(connectivitySnapshot().host.failure).not.toBe("offline");
    off();
  });

  it("checks immediately when the network comes back", async () => {
    const off = watch();
    await settle();
    window.dispatchEvent(new Event("offline"));
    await settle();
    const before = env.counts.host;

    window.dispatchEvent(new Event("online"));
    await settle();
    expect(connectivitySnapshot().offline).toBe(false);
    expect(env.counts.host).toBeGreaterThan(before);
    off();
  });
});

describe("settings", () => {
  it("re-checks when a base URL moves, because the old verdict is meaningless", async () => {
    const off = watch();
    await settle();
    const before = env.counts.host;

    for (const listener of env.settingsListeners) listener();
    await settle();
    expect(env.counts.host).toBeGreaterThan(before);
    off();
  });
});

describe("the machine target", () => {
  it("is not probed at all when nothing is paired", async () => {
    env.daemonApi = "";
    const off = watch();
    await settle();
    expect(env.counts.daemon).toBe(0);
    expect(connectivitySnapshot().machine.failure).toBeNull();
    off();
  });

  it("is not probed when the address is one this page could never call", async () => {
    env.loopbackPage = false;
    const off = watch();
    await settle();
    expect(env.counts.daemon).toBe(0);
    off();
  });

  it("separates a wrong service from a dead one", async () => {
    env.daemonOk = false;
    const off = watch();
    await settle();
    expect(connectivitySnapshot().machine.failure).toBe("not-opensesame");

    env.daemonError = new Error(
      "That URL answered, but it is not an OpenSesame daemon.",
    );
    checkNow();
    await settle();
    expect(connectivitySnapshot().machine.failure).toBe("not-opensesame");
    off();
  });

  it("classifies a timeout as a timeout", async () => {
    env.daemonError = new DOMException(
      "Timed out after 4000ms",
      "TimeoutError",
    );
    const off = watch();
    await settle();
    expect(connectivitySnapshot().machine.failure).toBe("timeout");
    off();
  });
});

describe("daemonIsProbable", () => {
  it("allows loopback only from a loopback page", () => {
    expect(daemonIsProbable("http://127.0.0.1:18790", true)).toBe(true);
    expect(daemonIsProbable("http://127.0.0.1:18790", false)).toBe(false);
  });

  it("allows a Serve URL from anywhere, and refuses what the fence refuses", () => {
    expect(daemonIsProbable("https://box.tailnet.ts.net", false)).toBe(true);
    // `normalizeTailnetBase` confines plain http to loopback and Tailscale
    // names; a cleartext host on the open internet never passes.
    expect(daemonIsProbable("http://evil.example.com", false)).toBe(false);
    expect(daemonIsProbable("ftp://box.tailnet.ts.net", false)).toBe(false);
    expect(daemonIsProbable("", true)).toBe(false);
  });
});
