import { describe, expect, it } from "vitest";
import {
  DomainError,
  assertDependencyClosure,
  assertManifestImmutable,
  elevatePrincipalAssurance,
  isProvisionalPrincipal,
  newPrincipalId,
} from "../index.js";
import { fixtures } from "./fixtures.js";

describe("assertDependencyClosure", () => {
  it("rejects accepting an unknown claim item", () => {
    const items = fixtures.claimItems("claimpub001");
    try {
      assertDependencyClosure(
        items,
        new Set(["ci_project", "ci_resource", "ci_ghost"]),
      );
      expect.unreachable("should have thrown");
    } catch (cause) {
      expect(cause).toBeInstanceOf(DomainError);
      if (!(cause instanceof DomainError)) throw cause;
      expect(cause.code).toBe("NOT_FOUND");
      expect(cause.details).toMatchObject({ id: "ci_ghost" });
    }
  });

  it("reports the missing dependency in the error details", () => {
    const items = fixtures.claimItems("claimpub001");
    try {
      assertDependencyClosure(items, new Set(["ci_resource"]));
      expect.unreachable("should have thrown");
    } catch (cause) {
      expect(cause).toBeInstanceOf(DomainError);
      if (!(cause instanceof DomainError)) throw cause;
      expect(cause.code).toBe("DEPENDENCY_CLOSURE");
      expect(cause.details).toMatchObject({
        itemId: "ci_resource",
        missingDependency: "ci_project",
      });
    }
  });

  it("accepts a superset that satisfies every required item and dependency", () => {
    const items = fixtures.claimItems("claimpub001");
    expect(() =>
      assertDependencyClosure(items, new Set(["ci_project", "ci_resource"])),
    ).not.toThrow();
  });
});

describe("assertManifestImmutable", () => {
  it("accepts an identical manifest digest", () => {
    const { session } = fixtures.pendingClaim();
    expect(() =>
      assertManifestImmutable(session, { ...session }),
    ).not.toThrow();
  });

  it("rejects a changed manifest digest with IMMUTABLE_FIELD", () => {
    const { session } = fixtures.pendingClaim();
    try {
      assertManifestImmutable(session, {
        ...session,
        targetManifestDigest: "sha256:tampered",
      });
      expect.unreachable("should have thrown");
    } catch (cause) {
      expect(cause).toBeInstanceOf(DomainError);
      if (!(cause instanceof DomainError)) throw cause;
      expect(cause.code).toBe("IMMUTABLE_FIELD");
      expect(cause.details).toMatchObject({
        original: session.targetManifestDigest,
        candidate: "sha256:tampered",
      });
    }
  });
});

describe("newPrincipalId", () => {
  it("defaults to the prn_ prefix", () => {
    expect(newPrincipalId()).toMatch(/^prn_[0-9a-f]{32}$/);
  });

  it("honors a custom prefix", () => {
    expect(newPrincipalId("svc")).toMatch(/^svc_[0-9a-f]{32}$/);
  });

  it("never repeats", () => {
    const ids = new Set(Array.from({ length: 64 }, () => newPrincipalId()));
    expect(ids.size).toBe(64);
  });
});

describe("elevatePrincipalAssurance", () => {
  it("flips a provisional principal to active by default", () => {
    const p = fixtures.provisionalPrincipal();
    const next = elevatePrincipalAssurance(
      p,
      "verified",
      undefined,
      fixtures.now,
    );
    expect(next.state).toBe("active");
    expect(next.assurance).toBe("verified");
    expect(next.version).toBe(p.version + 1);
    expect(next.updatedAt).toEqual(fixtures.now);
  });

  it("keeps the current state when elevating a non-provisional principal", () => {
    const p = fixtures.verifiedPrincipal();
    const next = elevatePrincipalAssurance(p, "mfa", undefined, fixtures.now);
    expect(next.state).toBe("active");
    expect(next.assurance).toBe("mfa");
  });

  it("stamps verifiedAt on first non-provisional elevation", () => {
    const p = fixtures.provisionalPrincipal();
    expect(p.verifiedAt).toBeUndefined();
    const next = elevatePrincipalAssurance(
      p,
      "self_asserted",
      "active",
      fixtures.now,
    );
    expect(next.verifiedAt).toEqual(fixtures.now);
  });

  it("preserves an existing verifiedAt timestamp", () => {
    const verifiedAt = new Date("2026-01-01T00:00:00.000Z");
    const p = fixtures.verifiedPrincipal({ verifiedAt });
    const next = elevatePrincipalAssurance(p, "mfa", "active", fixtures.now);
    expect(next.verifiedAt).toEqual(verifiedAt);
  });

  it("does not stamp verifiedAt when staying provisional", () => {
    const p = fixtures.provisionalPrincipal();
    const next = elevatePrincipalAssurance(
      p,
      "provisional",
      "provisional",
      fixtures.now,
    );
    expect(next.verifiedAt).toBeUndefined();
    expect(isProvisionalPrincipal(next)).toBe(true);
  });

  it("treats a provisional assurance on an active principal as provisional", () => {
    const p = fixtures.provisionalPrincipal({ state: "active" });
    expect(isProvisionalPrincipal(p)).toBe(true);
  });

  it("does not treat a verified active principal as provisional", () => {
    expect(isProvisionalPrincipal(fixtures.verifiedPrincipal())).toBe(false);
  });
});
