/**
 * The Identity plane's truth table (ADR 0160): which plane answers, and which
 * route families it serves.
 */

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  registerDeviceRoutes,
  resetDeviceRoutesForTests,
} from "./device-identity-routes.js";
import {
  DEVICE_CORE_FAMILIES,
  DEVICE_NEVER_FAMILIES,
  IDENTITY_ROUTE_FAMILIES,
  type IdentityRouteFamily,
  identityPlane,
  identityServes,
} from "./identity-plane.js";
import { saveSettings } from "./settings.js";

function settings(identityApi: string): void {
  saveSettings({
    hostApi: "",
    identityApi,
    daemonApi: "",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
}

const CONTRIBUTABLE = IDENTITY_ROUTE_FAMILIES.filter(
  (family) =>
    !DEVICE_CORE_FAMILIES.includes(family) &&
    !DEVICE_NEVER_FAMILIES.includes(family),
);

function contribute(id: string, serves: IdentityRouteFamily[]) {
  return registerDeviceRoutes({
    id,
    serves,
    dispatch: async () => null,
  });
}

beforeEach(() => {
  settings("");
  resetDeviceRoutesForTests();
});

afterEach(() => {
  resetDeviceRoutesForTests();
});

describe("identityPlane", () => {
  it("is the device when Settings names no Identity API", () => {
    expect(identityPlane()).toBe("device");
  });

  it("is remote when Settings names one, and the device when it is cleared again", () => {
    settings("https://id.example.test");
    expect(identityPlane()).toBe("remote");
    settings("");
    expect(identityPlane()).toBe("device");
  });
});

describe("identityServes on the device plane", () => {
  it("partitions the closed set: core, contributable, never", () => {
    const all = new Set<IdentityRouteFamily>([
      ...DEVICE_CORE_FAMILIES,
      ...CONTRIBUTABLE,
      ...DEVICE_NEVER_FAMILIES,
    ]);
    expect([...all].sort()).toEqual([...IDENTITY_ROUTE_FAMILIES].sort());
    expect(DEVICE_CORE_FAMILIES).toEqual(["session"]);
    expect(CONTRIBUTABLE).toEqual([
      "audit",
      "requests",
      "notifications",
      "directory",
    ]);
  });

  it("always serves a session, with nothing registered", () => {
    expect(identityServes("session")).toBe(true);
  });

  it("serves nothing else until a capability that is on registers it", () => {
    for (const family of CONTRIBUTABLE) {
      expect(identityServes(family)).toBe(false);
    }
    const off = contribute("identity.local-iam", ["directory", "audit"]);
    expect(identityServes("directory")).toBe(true);
    expect(identityServes("audit")).toBe(true);
    expect(identityServes("requests")).toBe(false);
    expect(identityServes("notifications")).toBe(false);
    off();
    expect(identityServes("directory")).toBe(false);
    expect(identityServes("audit")).toBe(false);
  });

  it("never serves what needs a server, however it is asked", () => {
    for (const family of DEVICE_NEVER_FAMILIES) {
      expect(identityServes(family)).toBe(false);
      expect(() => contribute("greedy", [family])).toThrow(TypeError);
      expect(identityServes(family)).toBe(false);
    }
  });

  it("says plainly which families need a server", () => {
    expect([...DEVICE_NEVER_FAMILIES].sort()).toEqual([
      "federation-callback",
      "mfa-codes",
      "org-signin",
      "wallet",
    ]);
  });
});

describe("identityServes on a remote plane", () => {
  it("serves every family, because it is asked for all of them over the wire", () => {
    settings("https://id.example.test");
    for (const family of IDENTITY_ROUTE_FAMILIES) {
      expect(identityServes(family)).toBe(true);
    }
  });

  it("does not depend on what the device registered", () => {
    settings("https://id.example.test");
    contribute("identity.local-iam", ["directory"]);
    resetDeviceRoutesForTests();
    expect(identityServes("directory")).toBe(true);
  });
});
