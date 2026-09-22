import { describe, expect, it } from "vitest";
import { validateDescriptor } from "./descriptor.js";
import { descriptor } from "./test-helpers.js";

describe("descriptor validator", () => {
  it("accepts a well-formed descriptor", () => {
    const result = validateDescriptor(descriptor("vault.write"));
    expect(result.ok).toBe(true);
  });

  it("rejects unknown fields (security-relevant data is never ignored)", () => {
    const result = validateDescriptor(
      descriptor("vault.write", { secretBackdoor: true }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.field === "secretBackdoor")).toBe(
        true,
      );
    }
  });

  it("rejects function-valued fields", () => {
    const base = descriptor("vault.write") as Record<string, unknown>;
    base.summary = () => "boom";
    const result = validateDescriptor(base as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.field === "summary")).toBe(true);
    }
  });

  it("rejects unknown keyAccess flags", () => {
    const base = descriptor("vault.write") as Record<string, unknown>;
    base.declaredPrivileges = {
      egressOrigins: [],
      keyAccess: {
        vaultRead: false,
        vaultWrite: false,
        deviceKeys: false,
        sudo: true,
      },
      browserPermissions: [],
    };
    const result = validateDescriptor(base as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.failures.some((f) =>
          f.field.includes("declaredPrivileges.keyAccess.sudo"),
        ),
      ).toBe(true);
    }
  });

  it("rejects malformed exposure digests and environments", () => {
    const result = validateDescriptor(
      descriptor("vault.write", {
        exposureDigest: "NOT-HEX",
        environments: ["teleport"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("rejects a non-object descriptor", () => {
    const result = validateDescriptor("vault.write");
    expect(result.ok).toBe(false);
  });
});
