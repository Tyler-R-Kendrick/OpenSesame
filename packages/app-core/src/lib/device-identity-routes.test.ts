/**
 * The device route registry (ADR 0160): contributions side by side, no shared
 * slot, no core family overridden, an unregister that removes only its own.
 */

/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DeviceRouteContribution,
  type DeviceRouteRequest,
  deviceAssurance,
  dispatchDeviceRoute,
  registerDeviceRoutes,
  registeredDeviceFamilies,
  resetDeviceRoutesForTests,
} from "./device-identity-routes.js";

const request = (bare: string): DeviceRouteRequest => ({
  path: bare,
  bare,
  method: "GET",
  init: {},
  caller: null,
});

function answering(
  id: string,
  prefix: string,
  serves: DeviceRouteContribution["serves"] = ["directory"],
): DeviceRouteContribution {
  return {
    id,
    serves,
    dispatch: async ({ bare }) =>
      bare.startsWith(prefix) ? new Response(id) : null,
  };
}

afterEach(() => {
  resetDeviceRoutesForTests();
});

describe("registerDeviceRoutes", () => {
  it("lets two capabilities answer side by side", async () => {
    registerDeviceRoutes(answering("a", "/v1/a", ["directory"]));
    registerDeviceRoutes(answering("b", "/v1/b", ["notifications"]));
    expect(await (await dispatchDeviceRoute(request("/v1/a/x")))?.text()).toBe(
      "a",
    );
    expect(await (await dispatchDeviceRoute(request("/v1/b/x")))?.text()).toBe(
      "b",
    );
    expect(await dispatchDeviceRoute(request("/v1/c"))).toBeNull();
    expect([...registeredDeviceFamilies()].sort()).toEqual([
      "directory",
      "notifications",
    ]);
  });

  it("asks contributions in registration order, first answer wins", async () => {
    registerDeviceRoutes(answering("first", "/v1/x"));
    registerDeviceRoutes(answering("second", "/v1/x"));
    expect(await (await dispatchDeviceRoute(request("/v1/x")))?.text()).toBe(
      "first",
    );
  });

  it("unregisters only its own registration", async () => {
    const offFirst = registerDeviceRoutes(answering("same", "/v1/old"));
    registerDeviceRoutes(answering("same", "/v1/new"));
    offFirst();
    expect(await dispatchDeviceRoute(request("/v1/old"))).toBeNull();
    expect(await (await dispatchDeviceRoute(request("/v1/new")))?.text()).toBe(
      "same",
    );
  });

  it("stops answering, and stops serving the family, once unregistered", async () => {
    const off = registerDeviceRoutes(answering("a", "/v1/a"));
    off();
    off();
    expect(await dispatchDeviceRoute(request("/v1/a"))).toBeNull();
    expect(registeredDeviceFamilies().size).toBe(0);
  });

  it("refuses the core family, the never families and an unknown one", () => {
    expect(() =>
      registerDeviceRoutes(answering("x", "/", ["session"])),
    ).toThrow(/host core/);
    expect(() => registerDeviceRoutes(answering("x", "/", ["wallet"]))).toThrow(
      /cannot serve/,
    );
    // A family name from outside the closed set, as a wire value would carry.
    const unknownFamily: DeviceRouteContribution["serves"] = overlapCast([
      "bogus",
    ]);
    expect(() =>
      registerDeviceRoutes(answering("x", "/", unknownFamily)),
    ).toThrow(/not a route family/);
    expect(registeredDeviceFamilies().size).toBe(0);
  });

  it("may answer a refusal for a family it does not serve", async () => {
    registerDeviceRoutes({
      id: "refuser",
      serves: [],
      dispatch: async ({ bare }) =>
        bare === "/v1/mfa/code/send"
          ? new Response("no", { status: 503 })
          : null,
    });
    expect(
      (await dispatchDeviceRoute(request("/v1/mfa/code/send")))?.status,
    ).toBe(503);
    expect(registeredDeviceFamilies().size).toBe(0);
  });
});

describe("deviceAssurance", () => {
  it("is provisional with no contribution vouching", async () => {
    expect(await deviceAssurance("personal")).toEqual({ level: "provisional" });
    registerDeviceRoutes(answering("a", "/v1/a"));
    expect(await deviceAssurance("personal")).toEqual({ level: "provisional" });
  });

  it("takes a proof that names when it was given", async () => {
    registerDeviceRoutes({
      ...answering("a", "/v1/a"),
      assurance: async () => ({ level: "phishing_resistant", verifiedAt: 7 }),
    });
    expect(await deviceAssurance("personal")).toEqual({
      level: "phishing_resistant",
      verifiedAt: 7,
    });
  });

  it("ignores a claim of more than provisional with no time of proof", async () => {
    registerDeviceRoutes({
      ...answering("a", "/v1/a"),
      assurance: async () => ({ level: "phishing_resistant" }),
    });
    expect(await deviceAssurance("personal")).toEqual({ level: "provisional" });
  });

  it("asks each contribution for the tomb it was given", async () => {
    const assurance = vi.fn(async () => null);
    registerDeviceRoutes({ ...answering("a", "/v1/a"), assurance });
    await deviceAssurance("guest");
    expect(assurance).toHaveBeenCalledWith("guest");
  });
});
