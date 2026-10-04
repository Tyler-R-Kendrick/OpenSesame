/**
 * The device route registry (ADR 0160): the table is real. A path has one
 * family, a family one owner, a handler answers only its family, and a
 * family is served only while a handler is registered.
 */

/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_NEVER_FAMILIES,
  type DeviceRouteContribution,
  type DeviceRouteRequest,
  deviceRouteFaults,
  dispatchDeviceRoute,
  familyOfPath,
  registerDeviceRoutes,
  registeredDeviceFamilies,
  resetDeviceRoutesForTests,
  subscribeDeviceRoutes,
} from "./device-identity-routes.js";

const request = (bare: string): Omit<DeviceRouteRequest, "family"> => ({
  path: bare,
  bare,
  method: "GET",
  body: null,
  caller: null,
});

const ok = (label: string) => async () => new Response(label);

afterEach(() => {
  resetDeviceRoutesForTests();
});

describe("familyOfPath", () => {
  it("puts every path in exactly one family, the longer prefix winning", () => {
    expect(familyOfPath("/v1/audit/events?limit=50")).toBe("audit");
    expect(familyOfPath("/v1/authorization-requests/ar_1")).toBe("requests");
    expect(familyOfPath("/v1/organizations")).toBe("directory");
    expect(familyOfPath("/v1/organizations/org_1")).toBe("directory");
    expect(familyOfPath("/v1/organizations/tenants/acme")).toBe("org-signin");
    expect(familyOfPath("/v1/organizations/by-domain/example.test")).toBe(
      "org-signin",
    );
    expect(familyOfPath("/v1/mfa/code/send")).toBe("mfa-codes");
    expect(familyOfPath("/v1/wallet/registrations")).toBe("wallet");
    expect(familyOfPath("/v1/notification-channels/push/subscriptions/x")).toBe(
      "notifications",
    );
    expect(familyOfPath("/v1/principals/me")).toBe("session");
  });

  it("does not match a longer name that merely starts the same", () => {
    expect(familyOfPath("/v1/organizations-evil")).toBeNull();
    expect(familyOfPath("/v1/agentsmith")).toBeNull();
  });

  it("puts an unknown path in no family", () => {
    expect(familyOfPath("/v1/x")).toBeNull();
    expect(familyOfPath("/v2/audit/events")).toBeNull();
  });
});

describe("registerDeviceRoutes", () => {
  it("lets two capabilities own different families side by side", async () => {
    registerDeviceRoutes({ id: "a", routes: { directory: ok("a") } });
    registerDeviceRoutes({ id: "b", routes: { notifications: ok("b") } });
    expect(
      await (await dispatchDeviceRoute(request("/v1/agents")))?.text(),
    ).toBe("a");
    expect(
      await (
        await dispatchDeviceRoute(request("/v1/notification-preferences/x"))
      )?.text(),
    ).toBe("b");
    expect([...registeredDeviceFamilies()].sort()).toEqual([
      "directory",
      "notifications",
    ]);
  });

  it("rejects a second owner of a family: nobody shadows a registrant", async () => {
    registerDeviceRoutes({
      id: "identity.local-iam",
      routes: { audit: ok("first") },
    });
    expect(() =>
      registerDeviceRoutes({ id: "squatter", routes: { audit: ok("second") } }),
    ).toThrow(/"identity.local-iam" already serves it/);
    expect(
      await (await dispatchDeviceRoute(request("/v1/audit/events")))?.text(),
    ).toBe("first");
  });

  it("registers nothing when any family of a contribution is refused", () => {
    expect(() =>
      registerDeviceRoutes({
        id: "mixed",
        routes: { directory: ok("d"), wallet: ok("w") },
      }),
    ).toThrow(/cannot serve/);
    expect(registeredDeviceFamilies().size).toBe(0);
  });

  it("replaces a registration of the same id, and the old unregister cannot remove it", async () => {
    const offFirst = registerDeviceRoutes({
      id: "same",
      routes: { audit: ok("old") },
    });
    registerDeviceRoutes({ id: "same", routes: { audit: ok("new") } });
    offFirst();
    expect(
      await (await dispatchDeviceRoute(request("/v1/audit/events")))?.text(),
    ).toBe("new");
  });

  it("stops answering, and stops serving the family, once unregistered", async () => {
    const off = registerDeviceRoutes({ id: "a", routes: { audit: ok("a") } });
    off();
    off();
    expect(await dispatchDeviceRoute(request("/v1/audit/events"))).toBeNull();
    expect(registeredDeviceFamilies().size).toBe(0);
  });

  it("refuses the core family, every never family and an unknown one", () => {
    expect(() =>
      registerDeviceRoutes({ id: "x", routes: { session: ok("x") } }),
    ).toThrow(/host core/);
    for (const family of DEVICE_NEVER_FAMILIES) {
      expect(() =>
        registerDeviceRoutes({ id: "x", routes: { [family]: ok("x") } }),
      ).toThrow(/cannot serve/);
    }
    const unknown: DeviceRouteContribution["routes"] = overlapCast({
      bogus: ok("x"),
    });
    expect(() => registerDeviceRoutes({ id: "x", routes: unknown })).toThrow(
      /not a route family/,
    );
    expect(registeredDeviceFamilies().size).toBe(0);
  });

  it("does not count a family as served when its handler is not a function", () => {
    const broken: DeviceRouteContribution["routes"] = overlapCast({
      audit: null,
    });
    expect(() => registerDeviceRoutes({ id: "x", routes: broken })).toThrow(
      /has no handler/,
    );
    const absent: DeviceRouteContribution["routes"] = overlapCast({
      audit: undefined,
    });
    registerDeviceRoutes({ id: "y", routes: absent });
    expect(registeredDeviceFamilies().has("audit")).toBe(false);
  });
});

describe("dispatchDeviceRoute", () => {
  it("lets a handler answer only the paths of the family it registered", async () => {
    // A handler for the directory that would answer anything it is handed.
    const greedy = vi.fn(async () => new Response("owned"));
    registerDeviceRoutes({ id: "greedy", routes: { directory: greedy } });
    expect(await dispatchDeviceRoute(request("/v1/mfa/code/send"))).toBeNull();
    expect(await dispatchDeviceRoute(request("/v1/audit/events"))).toBeNull();
    expect(
      await dispatchDeviceRoute(request("/v1/wallet/registrations")),
    ).toBeNull();
    expect(await dispatchDeviceRoute(request("/v1/unmapped"))).toBeNull();
    expect(greedy).not.toHaveBeenCalled();
    expect(
      await (await dispatchDeviceRoute(request("/v1/projects")))?.text(),
    ).toBe("owned");
    expect(greedy).toHaveBeenCalledTimes(1);
  });

  it("hands the handler its family, and no header", async () => {
    const seen: DeviceRouteRequest[] = [];
    registerDeviceRoutes({
      id: "probe",
      routes: {
        audit: async (received) => {
          seen.push(received);
          return new Response("{}");
        },
      },
    });
    await dispatchDeviceRoute({
      ...request("/v1/audit/events"),
      body: '{"a":1}',
    });
    expect(seen[0]?.family).toBe("audit");
    expect(seen[0]?.body).toBe('{"a":1}');
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      "bare",
      "body",
      "caller",
      "family",
      "method",
      "path",
    ]);
  });

  it("answers 500 for a handler that throws, records only its id, and leaves the others answering", async () => {
    registerDeviceRoutes({
      id: "broken",
      routes: {
        audit: async () => {
          throw new Error("secret dev_abc123 in a message");
        },
      },
    });
    registerDeviceRoutes({ id: "fine", routes: { directory: ok("fine") } });
    const failed = await dispatchDeviceRoute(request("/v1/audit/events"));
    expect(failed?.status).toBe(500);
    expect(await failed?.text()).not.toContain("dev_abc123");
    expect(deviceRouteFaults()).toEqual([{ id: "broken", family: "audit" }]);
    expect(JSON.stringify(deviceRouteFaults())).not.toContain("dev_abc123");
    expect(
      await (await dispatchDeviceRoute(request("/v1/agents")))?.text(),
    ).toBe("fine");
  });

  it("returns null when the owner declines the path", async () => {
    registerDeviceRoutes({ id: "a", routes: { directory: async () => null } });
    expect(await dispatchDeviceRoute(request("/v1/projects"))).toBeNull();
  });
});

describe("subscribeDeviceRoutes", () => {
  it("is told when a family appears and when it goes", () => {
    const heard = vi.fn();
    const off = subscribeDeviceRoutes(heard);
    const unregister = registerDeviceRoutes({
      id: "a",
      routes: { audit: ok("a") },
    });
    expect(heard).toHaveBeenCalledTimes(1);
    unregister();
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    registerDeviceRoutes({ id: "a", routes: { audit: ok("a") } });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("is not told for a registration that is refused", () => {
    const heard = vi.fn();
    subscribeDeviceRoutes(heard);
    expect(() =>
      registerDeviceRoutes({ id: "x", routes: { wallet: ok("x") } }),
    ).toThrow();
    expect(heard).not.toHaveBeenCalled();
  });
});
