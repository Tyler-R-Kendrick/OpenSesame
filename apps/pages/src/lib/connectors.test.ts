import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ loopbackPage: true }));

vi.mock("./settings.js", () => ({
  loadSettings: () => ({}),
  pageIsLoopback: () => env.loopbackPage,
  subscribeSettings: () => () => {},
  settingsEpoch: () => 0,
}));

import type { TargetState } from "./connectivity-monitor.js";
import {
  type ConnectorStatus,
  briefOrigin,
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
import type { PagesSettings } from "./settings.js";

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
  it("flags a git connector that Host has not authorized yet", () => {
    const status = classifyHistoryConnector(settings());
    expect(status.tone).toBe("attn");
    expect(status.detail).toBe("GitHub not authorized");
  });

  it("names the remote once the connector is authorized", () => {
    const status = classifyHistoryConnector(
      settings({
        capabilityConnectors: {
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
          encryption: { providerId: "webcrypto" },
          history: { providerId: "password-store" },
        },
      }),
    );
    expect(status.tone).toBe("live");
  });

  it("counts the built-in key vault as satisfied and not required", () => {
    const status = classifyKeysConnector(settings());
    expect(status.tone).toBe("live");
    expect(status.required).toBe(false);
    expect(status.detail).toBe("WebCrypto (this device)");
  });

  it("flags a cloud KMS binding that was never authorized", () => {
    const status = classifyKeysConnector(
      settings({
        capabilityConnectors: {
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
  } as const;

  it("counts only required connectors that are not live", () => {
    const list: ConnectorStatus[] = [
      {
        id: "host",
        name: "Host",
        tone: "attn",
        detail: "",
        required: true,
        ...base,
      },
      {
        id: "keys",
        name: "Key vault",
        tone: "off",
        detail: "",
        required: false,
        ...base,
      },
      {
        id: "identity",
        name: "Identity",
        tone: "live",
        detail: "",
        required: true,
        ...base,
      },
    ];
    expect(needsAttention(list)).toBe(1);
    expect(isOfflineSet(list)).toBe(false);
  });

  it("recognises the offline set", () => {
    const list: ConnectorStatus[] = [
      {
        id: "host",
        name: "Host",
        tone: "offline",
        detail: "Offline",
        required: true,
        ...base,
      },
    ];
    expect(isOfflineSet(list)).toBe(true);
  });
});
