/**
 * Internal ledgers and concealed secrets are not configuration documents: no
 * spelling of their path resolves (ADR 0160 §5 for the device identity key).
 */

import { describe, expect, it } from "vitest";
import { isForbiddenConfigPath } from "./forbidden.js";
import { lookupConfigResource } from "./registry.js";

describe("forbidden configuration paths", () => {
  it.each([
    "config/device-identity-key",
    "CONFIG/Device-Identity-Key",
    "config/./device-identity-key",
    "config%2Fdevice-identity-key",
    "settings/device-identity-key.yaml",
    "config/identity-grants",
    "config/../config/device-identity-key",
  ])("refuses %s, however it is written", (path) => {
    expect(isForbiddenConfigPath(path)).toBe(true);
    expect(lookupConfigResource(path)).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("still resolves the documented prefs path", () => {
    expect(isForbiddenConfigPath("settings/prefs.yaml")).toBe(false);
    expect(lookupConfigResource("settings/prefs.yaml").ok).toBe(true);
  });
});
