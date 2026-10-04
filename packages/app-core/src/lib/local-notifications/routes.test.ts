/**
 * What the device plane answers for notifications while `notifications.local`
 * is on (ADR 0160 §3, ADR 0162): the inbox is its one channel, and nothing
 * that needs a server is pretended.
 */

import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  harness,
  open,
  session,
  useDeviceIdentityHarness,
} from "../__tests__/device-identity-harness.js";
import { deviceIdentityFetch } from "../device-identity-host.js";
import { registerDeviceRoutes } from "../device-identity-routes.js";
import { identityServes } from "../identity-plane.js";
import { LOCAL_NOTIFICATIONS_DEVICE_ROUTES } from "./routes.js";

useDeviceIdentityHarness();

async function ask(path: string, token: string | null, method = "GET") {
  return deviceIdentityFetch(path, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("while notifications.local is on", () => {
  it("serves the family, and only while it is registered", async () => {
    expect(identityServes("notifications")).toBe(false);
    const off = registerDeviceRoutes(LOCAL_NOTIFICATIONS_DEVICE_ROUTES);
    expect(identityServes("notifications")).toBe(true);
    off();
    expect(identityServes("notifications")).toBe(false);
  });

  it("lists every channel kind and configures only the inbox", async () => {
    registerDeviceRoutes(LOCAL_NOTIFICATIONS_DEVICE_ROUTES);
    await open();
    const { accessToken } = await session();
    const res = await ask("/v1/notification-channels", accessToken);
    expect(res.status).toBe(200);
    const channels = overlapCast(await res.json()).channels;
    const rows = Array.isArray(channels) ? channels.map(overlapCast) : [];
    expect(rows.filter((row) => row.configured).map((row) => row.kind)).toEqual(
      ["in_app"],
    );
    // A server's channels are listed as what they are here: not configured.
    expect(rows.map((row) => row.kind)).toContain("native_push");
    expect(rows.find((row) => row.kind === "slack")?.configured).toBe(false);
  });

  it("answers no one without a live bearer, and nothing that is not a read", async () => {
    registerDeviceRoutes(LOCAL_NOTIFICATIONS_DEVICE_ROUTES);
    await open();
    const { accessToken } = await session();
    expect((await ask("/v1/notification-channels", null)).status).toBe(401);
    expect(
      (await ask("/v1/notification-channels", accessToken, "POST")).status,
    ).toBe(405);
  });

  it("leaves what needs a server unserved: routing, bindings, the effective route", async () => {
    registerDeviceRoutes(LOCAL_NOTIFICATIONS_DEVICE_ROUTES);
    await open();
    const { accessToken } = await session();
    for (const path of [
      "/v1/notification-preferences",
      "/v1/notification-preferences/effective?class=authorization_request",
      "/v1/notification-channels/bindings",
    ])
      expect((await ask(path, accessToken)).status, path).toBe(501);
  });

  it("answers locked while the vault is shut, like every family", async () => {
    registerDeviceRoutes(LOCAL_NOTIFICATIONS_DEVICE_ROUTES);
    await open();
    const { accessToken } = await session();
    harness.view = { kind: "locked" };
    expect((await ask("/v1/notification-channels", accessToken)).status).toBe(
      423,
    );
  });
});
