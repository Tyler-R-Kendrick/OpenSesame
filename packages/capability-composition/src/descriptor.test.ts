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

  it("collects every failure instead of stopping at the first", () => {
    const result = validateDescriptor(
      descriptor("vault.write", {
        dependencies: "nope",
        operationIds: ["ok.op", 7],
        exposureDigest: "ZZZ",
        environments: [],
        declaredPrivileges: { egressOrigins: ["http://plain"] },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("rejects bad origins, bad permissions, and non-boolean flags", () => {
    // One bad entry poisons the block: strict, never partially accepted.
    const origins = validateDescriptor(
      descriptor("vault.write", {
        declaredPrivileges: {
          egressOrigins: ["http://plain.example/x", "https://ok.example:443"],
          keyAccess: { vaultRead: false, vaultWrite: false, deviceKeys: false },
          browserPermissions: [],
        },
      }),
    );
    expect(origins.ok).toBe(false);
    const permissions = validateDescriptor(
      descriptor("vault.write", {
        declaredPrivileges: {
          egressOrigins: [],
          keyAccess: { vaultRead: false, vaultWrite: false, deviceKeys: false },
          browserPermissions: ["0bad", "notifications"],
        },
      }),
    );
    expect(permissions.ok).toBe(false);
    const flags = validateDescriptor(
      descriptor("vault.write", {
        declaredPrivileges: {
          egressOrigins: [],
          keyAccess: { vaultRead: "yes", vaultWrite: false, deviceKeys: false },
          browserPermissions: [],
        },
      }),
    );
    expect(flags.ok).toBe(false);
  });

  it("de-duplicates repeated ids", () => {
    const result = validateDescriptor(
      descriptor("vault.write", {
        operationIds: ["op.run", "op.run"],
        moduleIds: ["mod.a", "mod.a"],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.descriptor.operationIds).toEqual(["op.run"]);
      expect(result.descriptor.moduleIds).toEqual(["mod.a"]);
    }
  });

  it("accepts the worker-graph constraint and class fields", () => {
    const result = validateDescriptor(
      descriptor("vault.write", {
        workerGraphConstraint: {
          requiresWorker: true,
          allowedEnvironments: ["dedicated-worker"],
        },
        class: "core",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects oversize text and id lists", () => {
    const result = validateDescriptor(
      descriptor("vault.write", {
        title: "t".repeat(201),
        operationIds: Array.from({ length: 65 }, (_, i) => `op.${i}`),
      }),
    );
    expect(result.ok).toBe(false);
  });
});
