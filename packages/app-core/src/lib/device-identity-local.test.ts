/**
 * Browser-local backends for the device-native Identity host.
 */

/** @vitest-environment jsdom */
import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  deviceIdentityFetch,
  resetDeviceIdentitySessionsForTests,
} from "./device-identity-host.js";
import { LOCAL_IAM_DEVICE_ROUTES } from "./device-identity-local.js";
import {
  registerDeviceRoutes,
  resetDeviceRoutesForTests,
} from "./device-identity-routes.js";
import { saveSettings } from "./settings.js";

function emptyRemoteSettings(): void {
  saveSettings({
    hostApi: "",
    identityApi: "",
    daemonApi: "",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
}

beforeEach(() => {
  emptyRemoteSettings();
  resetDeviceIdentitySessionsForTests();
  registerDeviceRoutes(LOCAL_IAM_DEVICE_ROUTES);
});

afterEach(() => {
  resetDeviceIdentitySessionsForTests();
  resetDeviceRoutesForTests();
});

describe("device identity local routes", () => {
  it("lists vault projects and ensures the personal project", async () => {
    const ensure = await deviceIdentityFetch("/v1/projects/personal/ensure", {
      method: "POST",
      body: "{}",
    });
    expect(ensure.status).toBe(200);
    const personal = overlapCast(await ensure.json());
    expect(personal.slug).toBe("personal");
    expect(String(personal.displayName).length).toBeGreaterThan(0);

    const listed = await deviceIdentityFetch("/v1/projects");
    expect(listed.status).toBe(200);
    const body = overlapCast(await listed.json());
    expect(Array.isArray(body.projects)).toBe(true);
    const rows = Array.isArray(body.projects) ? body.projects : [];
    expect(
      rows.some(
        (row) =>
          isJsonObject(row) && isString(row.slug) && row.slug === "personal",
      ),
    ).toBe(true);
  });
});

describe("what the directory family answers", () => {
  it("answers nothing outside the directory, audit and requests families", async () => {
    expect(
      (await deviceIdentityFetch("/v1/notification-preferences/effective"))
        .status,
    ).toBe(501);
    expect((await deviceIdentityFetch("/v1/wallet/registrations")).status).toBe(
      501,
    );
    expect(
      (await deviceIdentityFetch("/v1/mfa/code/send", { method: "POST" }))
        .status,
    ).toBe(503);
  });

  it("answers the receipts and the inbox to a session only (ADR 0162)", async () => {
    // Their answers are the vault's own (`device-identity-inbox.test.ts`); a
    // caller with no live bearer is not given them.
    expect((await deviceIdentityFetch("/v1/audit/events")).status).toBe(401);
    expect(
      (await deviceIdentityFetch("/v1/authorization-requests")).status,
    ).toBe(401);
  });
});
