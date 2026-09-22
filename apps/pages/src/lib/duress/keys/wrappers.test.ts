import { describe, expect, it } from "vitest";
import {
  WRAPPER_CATALOG,
  assertNoSilentBypass,
  inventoryFromVaultSignals,
  inventoryWrappers,
  survivingAlternateWrappers,
} from "./wrappers.js";

describe("KEYS-A/C wrapper inventory", () => {
  it("never claims isolation for shared-root wrappers", () => {
    for (const entry of Object.values(WRAPPER_CATALOG)) {
      expect(entry.independentCompartment).toBe(false);
      expect(entry.admitsProtectedRootAlone).toBe(true);
    }
  });

  it("inventories enrolled wrappers from vault signals", () => {
    const rows = inventoryFromVaultSignals({
      hasPasswordWrap: true,
      hasPin: true,
      hasPasskeyPrf: true,
      hasAgeRecipient: true,
      hasRecoveryKey: true,
      hasSops: true,
      hasCloudEnvelope: true,
      hasLegacyWrap: true,
    });
    expect(rows.map((r) => r.kind).sort()).toEqual(
      [
        "age",
        "cloud_envelope",
        "legacy_wrap",
        "password",
        "pin",
        "recovery_key",
        "sops",
        "webauthn_prf",
      ].sort(),
    );
  });

  it("discloses surviving alternate wrappers for two-input claims", () => {
    const enrolled = ["password", "pin", "webauthn_prf"] as const;
    const warnings = survivingAlternateWrappers(enrolled, {
      twoInputRequired: true,
      holdActive: false,
    });
    expect(warnings.length).toBe(3);
    expect(() =>
      assertNoSilentBypass(enrolled, {
        twoInputRequired: true,
        holdActive: false,
      }),
    ).toThrow(/alternate_unlock_bypass/);
    expect(
      survivingAlternateWrappers(enrolled, {
        twoInputRequired: false,
        holdActive: false,
      }),
    ).toEqual([]);
  });

  it("dedupes inventoryWrappers", () => {
    expect(inventoryWrappers(["pin", "pin", "age"])).toHaveLength(2);
  });
});
