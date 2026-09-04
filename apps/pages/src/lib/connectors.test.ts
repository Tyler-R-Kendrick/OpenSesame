import { afterEach, describe, expect, it, vi } from "vitest";

const env = { loopbackPage: true };

import { defaultCapabilityConnectors } from "./capabilities.js";
import type { MonitorSnapshot, TargetState } from "./connectivity-monitor.js";
import {
  type ConnectorStatus,
  briefOrigin,
  buildConnectors,
  classifyHistoryConnector,
  classifyHostConnector,
  classifyIdentityConnector,
  classifyKeysConnector,
  classifyMachineConnector,
  isOfflineSet,
  needsAttention,
  repoHint,
} from "./connectors.js";
import type { HostPlane, IdentityPlane, PlaneStatus } from "./planes.js";
import type { FailureClass } from "./probe-failure.js";
import { settingsSeams } from "./settings.js";
import type { PagesSettings } from "./settings.js";

Object.assign(settingsSeams, {
  loadSettings: () => ({}),
  pageIsLoopback: () => env.loopbackPage,
  subscribeSettings: () => () => {},
  settingsEpoch: () => 0,
});

function plane(over: Partial<PlaneStatus> = {}): PlaneStatus {
  return {
    host: "live",
    hostBase: "http://127.0.0.1:18787",
    identity: "connected",
    identityBase: "http://127.0.0.1:18788",
    ...over,
  };
}

function target(over: Partial<TargetState> = {}): TargetState {
  return {
    health: "reachable",
    failure: null,
    lastCheckedAt: 1_000,
    checking: false,
    rttMs: 12,
    ...over,
  };
}

function settings(over: Partial<PagesSettings> = {}): PagesSettings {
  return {
    hostApi: "",
    identityApi: "",
    daemonApi: "",
    tursoUrl: "",
    mfaAppUrl: "",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
    ...over,
  };
}

afterEach(() => {
  env.loopbackPage = true;
});

describe("briefOrigin", () => {
  it("keeps host and port, drops the scheme and trailing slash", () => {
    expect(briefOrigin("http://127.0.0.1:18787/")).toBe("127.0.0.1:18787");
    expect(briefOrigin("https://box.tailnet.ts.net/host")).toBe(
      "box.tailnet.ts.net/host",
    );
  });

  it("passes through anything that is not a URL, and blanks empties", () => {
    expect(briefOrigin("  ")).toBe("");
    expect(briefOrigin("not a url")).toBe("not a url");
  });
});

describe("repoHint", () => {
  it("reduces a git remote to owner/repo", () => {
    expect(repoHint("https://github.com/Tyler-R-Kendrick/store.git")).toBe(
      "Tyler-R-Kendrick/store",
    );
  });

  it("leaves an scp-style or bare remote alone", () => {
    expect(repoHint("git@github.com:owner/store.git")).toBe(
      "git@github.com:owner/store",
    );
    expect(repoHint("")).toBe("");
  });
});

describe("classifyHostConnector", () => {
  const cases: Array<[HostPlane, ConnectorStatus["tone"]]> = [
    ["live", "live"],
    // A probe in flight must not flash amber on every cadence.
    ["pending", "live"],
    ["loopback", "attn"],
    ["down", "attn"],
    ["unset", "off"],
  ];

  it.each(cases)("maps host plane %s to %s", (host, tone) => {
    expect(classifyHostConnector(plane({ host }), target(), false).tone).toBe(
      tone,
    );
  });

  it("names the origin it is talking to when live", () => {
    expect(classifyHostConnector(plane(), target(), false).detail).toBe(
      "127.0.0.1:18787",
    );
  });

  it("says why a loopback host is hopeless from a remote page", () => {
    env.loopbackPage = false;
    expect(
      classifyHostConnector(plane({ host: "loopback" }), target(), false)
        .detail,
    ).toContain("unreachable from this page");
  });

  it("reports Down when nothing is even configured to be unreachable", () => {
    expect(
      classifyHostConnector(
        plane({ host: "down", hostBase: "" }),
        target({ health: "unreachable" }),
        false,
      ).detail,
    ).toBe("Down");
  });

  it("offline beats every endpoint diagnosis, but not 'never configured'", () => {
    const off = classifyHostConnector(plane({ host: "down" }), target(), true);
    expect(off.tone).toBe("offline");
    expect(off.detail).toBe("Offline");

    // Nothing configured stays 'off' — the network is not why.
    const unset = classifyHostConnector(
      plane({ host: "unset", hostBase: "" }),
      target(),
      true,
    );
    expect(unset.tone).toBe("off");
  });

  const failures: Array<[FailureClass, string]> = [
    ["timeout", "No answer in time · 127.0.0.1:18787"],
    ["unreachable", "Unreachable · 127.0.0.1:18787"],
    ["rejected", "Refused the request · 127.0.0.1:18787"],
    ["server-error", "Erroring · 127.0.0.1:18787"],
    ["not-opensesame", "Not OpenSesame · 127.0.0.1:18787"],
  ];

  it.each(failures)("states %s as its own thing", (failure, detail) => {
    expect(
      classifyHostConnector(
        plane({ host: "down" }),
        target({ health: "unreachable", failure }),
        false,
      ).detail,
    ).toBe(detail);
  });

  it("carries probe freshness through for the ceremony to show", () => {
    const status = classifyHostConnector(
      plane(),
      target({ lastCheckedAt: 42, checking: true }),
      false,
    );
    expect(status.lastCheckedAt).toBe(42);
    expect(status.checking).toBe(true);
  });
});

describe("classifyIdentityConnector", () => {
  const cases: Array<[IdentityPlane, ConnectorStatus["tone"]]> = [
    ["connected", "live"],
    ["none", "attn"],
    ["down", "attn"],
  ];

  it.each(cases)("maps identity plane %s to %s", (identity, tone) => {
    expect(
      classifyIdentityConnector(plane({ identity }), target(), false).tone,
    ).toBe(tone);
  });

  it("is off, not amber, when no Identity is configured at all", () => {
    const status = classifyIdentityConnector(
      plane({ identity: "down", identityBase: "" }),
      target(),
      false,
    );
    expect(status.tone).toBe("off");
    expect(status.detail).toBe("Not configured");
  });

  it("never pairs an amber glyph with the word Offline", () => {
    // Going offline stamps failure="offline" on every target. Coming back
    // clears the flag before the next probe lands, so for that window a
    // failing target still carries the stamp — and rendering it would put a
    // warning to go fix an endpoint next to copy saying nothing is wrong.
    const stale = classifyIdentityConnector(
      plane({ identity: "down" }),
      target({ health: "unreachable", failure: "offline" }),
      false,
    );
    expect(stale.tone).toBe("attn");
    expect(stale.detail).not.toBe("Offline");
    expect(stale.detail).toBe("Unreachable · 127.0.0.1:18788");
  });

  it("goes offline rather than blaming the identity endpoint", () => {
    const status = classifyIdentityConnector(
      plane({ identity: "down" }),
      target(),
      true,
    );
    expect(status.tone).toBe("offline");
    expect(status.detail).toBe("Offline");
  });

  it("distinguishes a plane that refused from one that did not answer", () => {
    expect(
      classifyIdentityConnector(
        plane({ identity: "down" }),
        target({ health: "unreachable", failure: "rejected" }),
        false,
      ).detail,
    ).toBe("Refused the request · 127.0.0.1:18788");
  });
});

describe("classifyMachineConnector", () => {
  const DAEMON = "http://127.0.0.1:18790";

  it("is 'off' when nothing is paired", () => {
    const status = classifyMachineConnector(target(), "", false);
    expect(status.tone).toBe("off");
    expect(status.detail).toBe("Not paired");
  });

  it("is 'off' when the address is one this page could never call", () => {
    env.loopbackPage = false;
    expect(classifyMachineConnector(target(), DAEMON, false).tone).toBe("off");
  });

  it("reads the first probe as live rather than as a failure", () => {
    expect(
      classifyMachineConnector(target({ health: "unknown" }), DAEMON, false)
        .detail,
    ).toBe("Checking 127.0.0.1:18790");
  });

  it("names the daemon when it answers, and the failure when it does not", () => {
    expect(classifyMachineConnector(target(), DAEMON, false).detail).toBe(
      "127.0.0.1:18790",
    );
    expect(
      classifyMachineConnector(
        target({ health: "unreachable", failure: "timeout" }),
        DAEMON,
        false,
      ).detail,
    ).toBe("No answer in time · 127.0.0.1:18790");
  });

  it("says a wrong service is a wrong service, not a dead one", () => {
    expect(
      classifyMachineConnector(
        target({ health: "unreachable", failure: "not-opensesame" }),
        DAEMON,
        false,
      ).detail,
    ).toBe("Not OpenSesame · 127.0.0.1:18790");
  });

  it("goes offline rather than blaming the daemon", () => {
    expect(classifyMachineConnector(target(), DAEMON, true).tone).toBe(
      "offline",
    );
  });
});

describe("capability connectors", () => {
  it("treats unauthorized git as optional and off, not as an error", () => {
    const status = classifyHistoryConnector(settings());
    expect(status.tone).toBe("off");
    expect(status.detail).toBe("Not connected");
  });

  it("stays off until a repository is bound, even after GitHub is authorized", () => {
    const status = classifyHistoryConnector(
      settings({
        capabilityConnectors: {
          ...defaultCapabilityConnectors(),
          encryption: { providerId: "webcrypto" },
          history: { providerId: "github", connectionId: "conn_1" },
        },
      }),
    );
    expect(status.tone).toBe("off");
    expect(status.detail).toBe("No repository selected");
  });

  it("names the remote once the connector is authorized", () => {
    const status = classifyHistoryConnector(
      settings({
        capabilityConnectors: {
          ...defaultCapabilityConnectors(),
          encryption: { providerId: "webcrypto" },
          history: {
            providerId: "github",
            connectionId: "conn_1",
            remote: "https://github.com/owner/store.git",
          },
        },
      }),
    );
    expect(status.tone).toBe("live");
    expect(status.detail).toBe("GitHub · owner/store");
  });

  it("treats a connector that needs no auth as live", () => {
    const status = classifyHistoryConnector(
      settings({
        capabilityConnectors: {
          ...defaultCapabilityConnectors(),
          encryption: { providerId: "webcrypto" },
          history: { providerId: "password-store" },
        },
      }),
    );
    expect(status.tone).toBe("live");
  });

  it("counts the built-in key vault as satisfied", () => {
    const status = classifyKeysConnector(settings());
    expect(status.tone).toBe("live");
    expect(status.detail).toBe("WebCrypto (this device)");
  });

  it("flags a cloud KMS binding that was never authorized", () => {
    const status = classifyKeysConnector(
      settings({
        capabilityConnectors: {
          ...defaultCapabilityConnectors(),
          encryption: { providerId: "aws-kms" },
          history: { providerId: "github" },
        },
      }),
    );
    expect(status.tone).toBe("attn");
  });

  it("carries no freshness, because nothing probes a binding", () => {
    const status = classifyKeysConnector(settings());
    expect(status.lastCheckedAt).toBeNull();
    expect(status.checking).toBe(false);
  });
});

describe("needsAttention", () => {
  const base = {
    failure: null,
    lastCheckedAt: null,
    checking: false,
    rttMs: null,
  } as const;

  it("counts a configured endpoint that is not answering", () => {
    const list: ConnectorStatus[] = [
      {
        id: "host",
        name: "Host",
        tone: "attn",
        detail: "",
        ...base,
      },
      {
        id: "keys",
        name: "Key vault",
        tone: "off",
        detail: "",
        ...base,
      },
      {
        id: "identity",
        name: "Identity",
        tone: "live",
        detail: "",
        ...base,
      },
    ];
    expect(needsAttention(list)).toBe(1);
    expect(isOfflineSet(list)).toBe(false);
  });

  it("never counts an endpoint nobody configured", () => {
    // Every plane is optional (ADR 0090), so an address nobody typed is not a
    // fault. `off` is the tone for "not configured"; only `attn` is a fault.
    const list: ConnectorStatus[] = [
      { id: "host", name: "Host", tone: "off", detail: "", ...base },
      {
        id: "identity",
        name: "Identity",
        tone: "off",
        detail: "",
        ...base,
      },
      {
        id: "machine",
        name: "This machine",
        tone: "off",
        detail: "",
        ...base,
      },
    ];
    expect(needsAttention(list)).toBe(0);
  });

  it("leaves a binding's own attention to the binding", () => {
    // Git history waiting to be authorized is a thing to finish, not an
    // address that stopped answering, so it never lands in this count.
    const list: ConnectorStatus[] = [
      { id: "history", name: "Git history", tone: "attn", detail: "", ...base },
      { id: "keys", name: "Key vault", tone: "attn", detail: "", ...base },
    ];
    expect(needsAttention(list)).toBe(0);
  });

  it("recognises the offline set", () => {
    const list: ConnectorStatus[] = [
      {
        id: "host",
        name: "Host",
        tone: "offline",
        detail: "Offline",
        ...base,
      },
    ];
    expect(isOfflineSet(list)).toBe(true);
  });
});

describe("buildConnectors", () => {
  function snapshot(over: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
    return {
      offline: false,
      host: target(),
      identity: target(),
      machine: target(),
      nextCheckAt: null,
      ...over,
    };
  }

  it("builds all five, in bar order", () => {
    const built = buildConnectors(plane(), snapshot(), settings());
    expect(built.map((c) => c.id)).toEqual([
      "host",
      "identity",
      "machine",
      "history",
      "keys",
    ]);
  });

  it("reads the daemon address from settings, not from the plane status", () => {
    const built = buildConnectors(
      plane(),
      snapshot(),
      settings({ daemonApi: "http://127.0.0.1:18790" }),
    );
    const machine = built.find((c) => c.id === "machine");
    expect(machine?.detail).toBe("127.0.0.1:18790");
  });

  it("puts every network connector into offline together", () => {
    const built = buildConnectors(
      plane(),
      snapshot({ offline: true }),
      settings({ daemonApi: "http://127.0.0.1:18790" }),
    );
    const tones = Object.fromEntries(built.map((c) => [c.id, c.tone]));
    expect(tones.host).toBe("offline");
    expect(tones.identity).toBe("offline");
    expect(tones.machine).toBe("offline");
    // Bindings are not reachability, so they keep saying what they are bound to.
    expect(tones.keys).toBe("live");
    expect(isOfflineSet(built)).toBe(true);
  });

  it("counts configured-but-broken connectors, never merely unconfigured ones", () => {
    const built = buildConnectors(
      plane({ host: "down", identity: "none" }),
      snapshot({ host: target({ health: "unreachable" }) }),
      settings(),
    );
    // Host down and Identity sessionless are configured addresses that are
    // not answering — two. The unpaired machine, optional git history and
    // the built-in key vault are not problems (ADR 0090).
    expect(needsAttention(built)).toBe(2);
  });

  it("asks for nothing on a deployment with no backend at all", () => {
    // The production static deploy: no Host, no Identity, no daemon. That is
    // a complete deployment, and the connectivity chip must not say three
    // things need setting up.
    const built = buildConnectors(
      plane({
        host: "unset",
        hostBase: "",
        identity: "none",
        identityBase: "",
      }),
      snapshot({}),
      settings(),
    );
    expect(needsAttention(built)).toBe(0);
  });
});
