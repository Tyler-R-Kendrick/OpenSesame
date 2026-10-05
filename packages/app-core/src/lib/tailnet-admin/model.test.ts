import { describe, expect, it } from "vitest";
import {
  deviceMarks,
  isExitNode,
  joinCommand,
  keyFacts,
  needsAttention,
  offersExitNode,
  parseTags,
  relativeTo,
  shortName,
  validDescription,
  validName,
  validRoute,
  visibleDevices,
  waitingRoutes,
} from "./model.js";
import type { TailnetDevice } from "./wire.js";

const NOW = Date.parse("2026-10-05T10:00:00Z");

function device(overrides: Partial<TailnetDevice> = {}): TailnetDevice {
  return {
    id: "n1",
    name: "web-01.tail4c2e.ts.net",
    hostname: "web-01",
    os: "linux",
    clientVersion: "1.80.2",
    updateAvailable: false,
    user: "amelie@example.com",
    addresses: ["100.101.102.103"],
    tags: [],
    authorized: true,
    external: false,
    ephemeral: false,
    keyExpiryDisabled: false,
    expires: "2027-03-01T00:00:00Z",
    created: "2026-09-01T00:00:00Z",
    lastSeen: "2026-10-05T09:00:00Z",
    connected: true,
    blocksIncoming: false,
    sshEnabled: false,
    multipleConnections: false,
    advertisedRoutes: [],
    enabledRoutes: [],
    tailnetLockError: null,
    ...overrides,
  };
}

describe("device marks", () => {
  it("a healthy device is just online", () => {
    expect(deviceMarks(device(), NOW)).toEqual([
      { tone: "ok", label: "Online" },
    ]);
    expect(needsAttention(device(), NOW)).toBe(false);
  });

  it("says what needs someone, worst first", () => {
    const marks = deviceMarks(
      device({
        authorized: false,
        connected: false,
        lastSeen: null,
        expires: "2026-10-01T00:00:00Z",
        multipleConnections: true,
        updateAvailable: true,
      }),
      NOW,
    ).map((m) => m.label);
    expect(marks).toEqual([
      "Several machines share this device's key",
      "Key expired",
      "Waiting for approval",
      "Update available",
      "Never seen",
    ]);
  });

  it("calls out a key about to expire, and none when expiry is off", () => {
    const soon = device({ expires: "2026-10-08T10:00:00Z" });
    expect(deviceMarks(soon, NOW)[0]?.label).toBe("Key expires in 3 days");
    expect(
      needsAttention(device({ ...soon, keyExpiryDisabled: true }), NOW),
    ).toBe(false);
  });

  it("counts routes waiting, an exit node once", () => {
    const routed = device({
      advertisedRoutes: ["10.0.0.0/16", "0.0.0.0/0", "::/0"],
      enabledRoutes: ["10.0.0.0/16"],
    });
    expect(offersExitNode(routed)).toBe(true);
    expect(isExitNode(routed)).toBe(false);
    expect(waitingRoutes(routed)).toBe(1);
    expect(deviceMarks(routed, NOW)[0]?.label).toBe(
      "1 route waiting for approval",
    );
    const approved = device({
      ...routed,
      enabledRoutes: [...routed.advertisedRoutes],
    });
    expect(isExitNode(approved)).toBe(true);
    expect(waitingRoutes(approved)).toBe(0);
  });

  it("an offline device says when it was last seen", () => {
    expect(deviceMarks(device({ connected: false }), NOW)).toEqual([
      { tone: "idle", label: "Offline, last seen 1 hour ago" },
    ]);
    expect(relativeTo("not a date", NOW)).toBeNull();
  });
});

describe("visible devices", () => {
  const list = [
    device({ id: "a", name: "zeta.t.ts.net" }),
    device({ id: "b", name: "alpha.t.ts.net", connected: false }),
    device({
      id: "c",
      name: "phone.t.ts.net",
      authorized: false,
      tags: ["tag:mobile"],
    }),
  ];

  it("puts devices waiting for approval first, then by name", () => {
    expect(visibleDevices(list, "all", "", NOW).map(shortName)).toEqual([
      "phone",
      "alpha",
      "zeta",
    ]);
  });

  it("filters and searches", () => {
    expect(visibleDevices(list, "attention", "", NOW).map((d) => d.id)).toEqual(
      ["c"],
    );
    expect(visibleDevices(list, "offline", "", NOW).map((d) => d.id)).toEqual([
      "b",
    ]);
    expect(visibleDevices(list, "online", "", NOW).map((d) => d.id)).toEqual([
      "c",
      "a",
    ]);
    expect(visibleDevices(list, "all", "mobile", NOW).map((d) => d.id)).toEqual(
      ["c"],
    );
  });
});

describe("form checks mirror the daemon's", () => {
  it("names", () => {
    expect(validName("web-01")).toBe(true);
    expect(validName("")).toBe(true);
    expect(validName("-web")).toBe(false);
    expect(validName("web.example")).toBe(false);
  });

  it("tags", () => {
    expect(parseTags("web, tag:ci  web")).toEqual(["tag:ci", "tag:web"]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags("Web")).toBeNull();
    expect(parseTags("2fa")).toBeNull();
  });

  it("routes", () => {
    for (const ok of [
      "10.0.0.0/16",
      "0.0.0.0/0",
      "192.168.1.7/32",
      "::/0",
      "fd00::/8",
    ])
      expect(validRoute(ok), ok).toBe(true);
    for (const bad of ["10.0.0.1/16", "10.0.0.0/33", "10.0.0.0", "300.0.0.0/8"])
      expect(validRoute(bad), bad).toBe(false);
  });

  it("descriptions and the join command", () => {
    expect(validDescription("lab runners")).toBe(true);
    expect(validDescription("bad!")).toBe(false);
    expect(joinCommand("tskey-auth-x")).toBe(
      "tailscale up --auth-key=tskey-auth-x",
    );
  });

  it("key facts", () => {
    expect(
      keyFacts({
        id: "k",
        description: "",
        created: null,
        expires: null,
        revoked: null,
        invalid: false,
        reusable: true,
        ephemeral: false,
        preauthorized: true,
        tags: ["tag:ci"],
      }),
    ).toBe("reusable · pre-approved · tag:ci");
  });
});
