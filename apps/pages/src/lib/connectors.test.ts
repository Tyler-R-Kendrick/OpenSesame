import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ loopbackPage: true }));

vi.mock("./settings.js", () => ({
  loadSettings: () => ({}),
  pageIsLoopback: () => env.loopbackPage,
  subscribeSettings: () => () => {},
}));

import {
  type ConnectorStatus,
  type DaemonReach,
  briefOrigin,
  classifyHistoryConnector,
  classifyHostConnector,
  classifyIdentityConnector,
  classifyKeysConnector,
  classifyMachineConnector,
  daemonIsProbable,
  needsAttention,
  repoHint,
} from "./connectors.js";
import type { HostPlane, IdentityPlane, PlaneStatus } from "./planes.js";
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
    // A probe in flight must not flash amber on every route remount.
    ["pending", "live"],
    ["loopback", "attn"],
    ["down", "attn"],
    ["unset", "off"],
  ];

  it.each(cases)("maps host plane %s to %s", (host, tone) => {
    expect(classifyHostConnector(plane({ host })).tone).toBe(tone);
  });

  it("names the origin it is talking to when live", () => {
    expect(classifyHostConnector(plane()).detail).toBe("127.0.0.1:18787");
  });

  it("says why a loopback host is hopeless from a remote page", () => {
    env.loopbackPage = false;
    expect(classifyHostConnector(plane({ host: "loopback" })).detail).toContain(
      "unreachable from this page",
    );
  });

  it("reads a loopback host on a loopback page as simply unreachable", () => {
    expect(classifyHostConnector(plane({ host: "loopback" })).detail).toBe(
      "Unreachable · 127.0.0.1:18787",
    );
  });

  it("reports Down when nothing is even configured to be unreachable", () => {
    expect(
      classifyHostConnector(plane({ host: "down", hostBase: "" })).detail,
    ).toBe("Down");
  });
});

describe("classifyIdentityConnector", () => {
  const cases: Array<[IdentityPlane, ConnectorStatus["tone"]]> = [
    ["connected", "live"],
    ["none", "attn"],
    ["down", "attn"],
  ];

  it.each(cases)("maps identity plane %s to %s", (identity, tone) => {
    expect(classifyIdentityConnector(plane({ identity })).tone).toBe(tone);
  });

  it("is off, not amber, when no Identity is configured at all", () => {
    const status = classifyIdentityConnector(
      plane({ identity: "down", identityBase: "" }),
    );
    expect(status.tone).toBe("off");
    expect(status.detail).toBe("Not configured");
  });
});

describe("classifyMachineConnector", () => {
  const cases: Array<[DaemonReach, ConnectorStatus["tone"]]> = [
    ["unset", "off"],
    ["checking", "live"],
    ["paired", "live"],
    ["unreachable", "attn"],
  ];

  it.each(cases)("maps daemon reach %s to %s", (reach, tone) => {
    expect(
      classifyMachineConnector(reach, "https://box.tailnet.ts.net").tone,
    ).toBe(tone);
  });

  it("names the daemon that did not answer", () => {
    expect(
      classifyMachineConnector("unreachable", "https://box.tailnet.ts.net")
        .detail,
    ).toBe("No answer from box.tailnet.ts.net");
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
});

describe("daemonIsProbable", () => {
  it("allows loopback only from a loopback page", () => {
    expect(daemonIsProbable("http://127.0.0.1:18790")).toBe(true);
    env.loopbackPage = false;
    expect(daemonIsProbable("http://127.0.0.1:18790")).toBe(false);
  });

  it("allows a Serve URL from anywhere, and refuses what the fence refuses", () => {
    env.loopbackPage = false;
    expect(daemonIsProbable("https://box.tailnet.ts.net")).toBe(true);
    // `normalizeTailnetBase` confines plain http to loopback and Tailscale
    // names; a cleartext host on the open internet never passes.
    expect(daemonIsProbable("http://evil.example.com")).toBe(false);
    expect(daemonIsProbable("ftp://box.tailnet.ts.net")).toBe(false);
    expect(daemonIsProbable("")).toBe(false);
  });
});

describe("needsAttention", () => {
  it("counts only required connectors that are not live", () => {
    const list: ConnectorStatus[] = [
      { id: "host", name: "Host", tone: "attn", detail: "", required: true },
      {
        id: "keys",
        name: "Key vault",
        tone: "off",
        detail: "",
        required: false,
      },
      {
        id: "identity",
        name: "Identity",
        tone: "live",
        detail: "",
        required: true,
      },
    ];
    expect(needsAttention(list)).toBe(1);
  });
});
