import { describe, expect, it } from "vitest";

import {
  type BootstrapDependencyNode,
  assertBootstrapFeasible,
  findBootstrapCycles,
  hasIndependentBootstrapPath,
} from "./bootstrap-graph.js";
import { ProtectionError } from "./errors.js";

describe("bootstrap-graph (KP-26 / KP-37)", () => {
  it("accepts a password protector with no vault-sealed dependency", () => {
    const nodes: BootstrapDependencyNode[] = [
      {
        id: "protector:password",
        kind: "protector",
        availability: "independent",
        dependsOn: [],
      },
    ];
    expect(findBootstrapCycles(nodes)).toEqual([]);
    expect(hasIndependentBootstrapPath(nodes, ["protector:password"])).toBe(
      true,
    );
    expect(() =>
      assertBootstrapFeasible(nodes, ["protector:password"]),
    ).not.toThrow();
  });

  it("detects age identity sealed only inside the locked vault (KP-26)", () => {
    const nodes: BootstrapDependencyNode[] = [
      {
        id: "protector:age",
        kind: "protector",
        availability: "vault-sealed",
        dependsOn: ["age-identity:primary"],
      },
      {
        id: "age-identity:primary",
        kind: "age-identity",
        availability: "vault-sealed",
        dependsOn: ["protector:age"],
      },
    ];
    const cycles = findBootstrapCycles(nodes);
    expect(cycles.length).toBeGreaterThan(0);
    expect(hasIndependentBootstrapPath(nodes, ["protector:age"])).toBe(false);
    expect(() => assertBootstrapFeasible(nodes, ["protector:age"])).toThrow(
      ProtectionError,
    );
    try {
      assertBootstrapFeasible(nodes, ["protector:age"]);
    } catch (error) {
      expect(error).toBeInstanceOf(ProtectionError);
      if (error instanceof ProtectionError) {
        expect(error.code).toBe("bootstrap_cycle");
      }
    }
  });

  it("rejects cloud protector whose only credential is vault-sealed (KP-37)", () => {
    const nodes: BootstrapDependencyNode[] = [
      {
        id: "protector:aws-kms",
        kind: "protector",
        availability: "vault-sealed",
        dependsOn: ["cloud-credential:aws"],
      },
      {
        id: "cloud-credential:aws",
        kind: "cloud-credential",
        availability: "vault-sealed",
        dependsOn: [],
      },
    ];
    expect(hasIndependentBootstrapPath(nodes, ["protector:aws-kms"])).toBe(
      false,
    );
    expect(() => assertBootstrapFeasible(nodes, ["protector:aws-kms"])).toThrow(
      /locked vault/,
    );
  });

  it("allows cloud protector when an independent native session can recover", () => {
    const nodes: BootstrapDependencyNode[] = [
      {
        id: "protector:aws-kms",
        kind: "protector",
        availability: "independent",
        dependsOn: ["native-session:aws"],
      },
      {
        id: "native-session:aws",
        kind: "native-session",
        availability: "independent",
        dependsOn: [],
      },
      {
        id: "cloud-credential:in-vault",
        kind: "cloud-credential",
        availability: "vault-sealed",
        dependsOn: [],
      },
    ];
    expect(hasIndependentBootstrapPath(nodes, ["protector:aws-kms"])).toBe(
      true,
    );
    expect(() =>
      assertBootstrapFeasible(nodes, ["protector:aws-kms"]),
    ).not.toThrow();
  });

  it("does not treat external-unproven alone as an independent path", () => {
    const nodes: BootstrapDependencyNode[] = [
      {
        id: "protector:age-recovery",
        kind: "protector",
        availability: "external-unproven",
        dependsOn: [],
      },
    ];
    expect(hasIndependentBootstrapPath(nodes, ["protector:age-recovery"])).toBe(
      false,
    );
  });
});
