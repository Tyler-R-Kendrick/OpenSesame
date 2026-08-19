import { describe, expect, it } from "vitest";
import {
  DomainError,
  assertDependencyClosure,
  assertNotSameAsDeviceAuth,
  assertPrincipalIdStable,
  elevatePrincipalAssurance,
  isProvisionalPrincipal,
} from "../index.js";
import { fixtures } from "./fixtures.js";

describe("domain invariants", () => {
  it("treats provisional as principal state, not a separate type", () => {
    const p = fixtures.provisionalPrincipal();
    expect(isProvisionalPrincipal(p)).toBe(true);
    const upgraded = elevatePrincipalAssurance(
      p,
      "verified",
      "active",
      fixtures.now,
    );
    expect(upgraded.id).toBe(p.id);
    expect(upgraded.assurance).toBe("verified");
    assertPrincipalIdStable(p, upgraded);
  });

  it("rejects principal id mutation", () => {
    const p = fixtures.provisionalPrincipal();
    expect(() => assertPrincipalIdStable(p, { ...p, id: "prn_other" })).toThrow(
      DomainError,
    );
  });

  it("keeps claim ≠ device authorization", () => {
    const { session } = fixtures.pendingClaim();
    const device = fixtures.pendingDeviceAuth({ id: session.id });
    expect(() => assertNotSameAsDeviceAuth(session, device)).toThrow(
      DomainError,
    );
    expect(() =>
      assertNotSameAsDeviceAuth(session, fixtures.pendingDeviceAuth()),
    ).not.toThrow();
  });

  it("enforces partial claim dependency closure", () => {
    const items = fixtures.claimItems("claimpub001");
    expect(() =>
      assertDependencyClosure(items, new Set(["ci_resource"])),
    ).toThrow(DomainError);
    expect(() =>
      assertDependencyClosure(items, new Set(["ci_project", "ci_resource"])),
    ).not.toThrow();
    expect(() => assertDependencyClosure(items, new Set())).toThrow(
      DomainError,
    );
  });
});
