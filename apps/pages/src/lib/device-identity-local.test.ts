/**
 * Browser-local backends for the device-native Identity host.
 */

/** @vitest-environment jsdom */
import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import { deviceIdentityFetch } from "./device-identity-host.js";
import { resetDeviceIdentitySessionsForTests } from "./device-identity-host.js";
import { saveSettings } from "./settings.js";

function emptyRemoteSettings(): void {
  saveSettings({
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
  });
}

beforeEach(() => {
  emptyRemoteSettings();
  resetDeviceIdentitySessionsForTests();
});

afterEach(() => {
  resetDeviceIdentitySessionsForTests();
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
