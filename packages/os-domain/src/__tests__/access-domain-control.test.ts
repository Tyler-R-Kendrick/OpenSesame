import { describe, expect, it } from "vitest";
import {
  ACCESS_DOMAIN_REFUSALS,
  type AccessDomainForest,
  type AccessRealm,
  type ControlAssignment,
  type ControlIndex,
  type ControlScope,
  DOMAIN_INHERITANCE_WIRE,
  DOMAIN_LIFETIME_WIRE,
  DOMAIN_PROJECT_KIND_WIRE,
  DOMAIN_ROLE_WIRE,
  DOMAIN_SCOPE_WIRE,
  type DomainRole,
  assertMayAdminister,
  canAdminister,
  canTransferOwnership,
  createDomain,
  domainRoleFromOrganizationRole,
  domainRoleFromProjectRole,
  effectiveControl,
  emptyControlIndex,
  emptyForest,
  insertControl,
  insertDelegatedControl,
  organizationRoleFromDomainRole,
  projectRoleFromDomainRole,
  removeControl,
  roleCovers,
  setInheritance,
} from "../access-domain/index.js";
import { DomainError } from "../errors.js";
import type { ProjectKind } from "../types.js";

const NOW = new Date("2026-03-01T00:00:00Z");

function realmOf(projectKind: ProjectKind): AccessRealm {
  return { projectId: "prj_alpha", projectKind };
}

/** A two-level estate: `platform` with `prod` and `staging` beneath it. */
function estate(projectKind: ProjectKind): AccessDomainForest {
  let forest = createDomain(emptyForest(realmOf(projectKind)), {
    id: "d_pf",
    slug: "platform",
    displayName: "Platform",
    createdAt: NOW,
  });
  forest = createDomain(forest, {
    id: "d_prod",
    parentId: "d_pf",
    slug: "prod",
    displayName: "Prod",
    createdAt: NOW,
  });
  return createDomain(forest, {
    id: "d_stg",
    parentId: "d_pf",
    slug: "staging",
    displayName: "Staging",
    createdAt: NOW,
  });
}

function grant(
  id: string,
  domainId: string,
  principalId: string,
  role: DomainRole,
  scope: ControlScope,
): ControlAssignment {
  return { id, domainId, principalId, role, scope };
}

/**
 * The rule a call broke, so a test names the refusal rather than just asserting
 * that something threw. Rethrows anything that is not a domain refusal.
 */
function reason(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return String(error.details.reason);
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("access domain control", () => {
  it("reaches down with subtree scope and stays put with domain-only scope", () => {
    const forest = estate("standard");
    let index: ControlIndex = emptyControlIndex();
    index = insertControl(
      index,
      forest,
      grant("c_wide", "d_pf", "prn_wide", "admin", "subtree"),
    );
    index = insertControl(
      index,
      forest,
      grant("c_narrow", "d_pf", "prn_narrow", "owner", "domain_only"),
    );

    const inherited = effectiveControl(index, forest, "d_prod", "prn_wide");
    expect(inherited?.role).toBe("admin");
    expect(inherited?.viaDomainId).toBe("d_pf");
    expect(
      effectiveControl(index, forest, "d_prod", "prn_narrow"),
    ).toBeUndefined();
    expect(effectiveControl(index, forest, "d_pf", "prn_narrow")?.role).toBe(
      "owner",
    );
  });

  it("stops the walk at an isolated domain, for the branch and not just the node", () => {
    let forest = createDomain(estate("standard"), {
      id: "d_eu",
      parentId: "d_prod",
      slug: "eu",
      displayName: "EU",
      createdAt: NOW,
    });
    forest = setInheritance(forest, "d_prod", "isolated");
    const index = insertControl(
      emptyControlIndex(),
      forest,
      grant("c_top", "d_pf", "prn_top", "owner", "subtree"),
    );

    expect(
      effectiveControl(index, forest, "d_prod", "prn_top"),
    ).toBeUndefined();
    expect(effectiveControl(index, forest, "d_eu", "prn_top")).toBeUndefined();
    expect(effectiveControl(index, forest, "d_stg", "prn_top")?.role).toBe(
      "owner",
    );
  });

  it("takes the strongest applicable role and names where it came from", () => {
    const forest = estate("standard");
    let index = insertControl(
      emptyControlIndex(),
      forest,
      grant("c_low", "d_pf", "prn_me", "member", "subtree"),
    );
    index = insertControl(
      index,
      forest,
      grant("c_high", "d_prod", "prn_me", "owner", "domain_only"),
    );

    const held = effectiveControl(index, forest, "d_prod", "prn_me");
    expect(held?.role).toBe("owner");
    expect(held?.viaDomainId).toBe("d_prod");
  });

  it("records control once per principal per domain and withdraws it by id", () => {
    const forest = estate("standard");
    const index = insertControl(
      emptyControlIndex(),
      forest,
      grant("c_1", "d_pf", "prn_me", "member", "subtree"),
    );
    expect(
      reason(() =>
        insertControl(
          index,
          forest,
          grant("c_2", "d_pf", "prn_me", "owner", "subtree"),
        ),
      ),
    ).toBe("conflict");
    expect(
      reason(() =>
        insertControl(
          index,
          forest,
          grant("c_1", "d_prod", "prn_other", "member", "subtree"),
        ),
      ),
    ).toBe("conflict");
    expect(removeControl(index, "c_1").assignments.size).toBe(0);
  });

  it("never lets delegation widen authority", () => {
    const forest = estate("standard");
    let index = insertControl(
      emptyControlIndex(),
      forest,
      grant("c_admin", "d_pf", "prn_admin", "admin", "subtree"),
    );
    index = insertControl(
      index,
      forest,
      grant("c_member", "d_pf", "prn_member", "member", "subtree"),
    );

    expect(
      reason(() =>
        insertDelegatedControl(
          index,
          forest,
          "prn_admin",
          grant("c_new", "d_prod", "prn_new", "owner", "subtree"),
        ),
      ),
    ).toBe("control_widen");
    expect(
      reason(() =>
        insertDelegatedControl(
          index,
          forest,
          "prn_member",
          grant("c_new", "d_prod", "prn_new", "member", "subtree"),
        ),
      ),
    ).toBe("control_widen");
    expect(
      reason(() =>
        insertDelegatedControl(
          index,
          forest,
          "prn_stranger",
          grant("c_new", "d_prod", "prn_new", "member", "subtree"),
        ),
      ),
    ).toBe("control_widen");
    expect(() =>
      insertDelegatedControl(
        index,
        forest,
        "prn_admin",
        grant("c_new", "d_prod", "prn_new", "admin", "subtree"),
      ),
    ).not.toThrow();
  });

  it("requires an administering role to administer", () => {
    const forest = estate("standard");
    let index = insertControl(
      emptyControlIndex(),
      forest,
      grant("c_member", "d_pf", "prn_member", "member", "subtree"),
    );
    index = insertControl(
      index,
      forest,
      grant("c_owner", "d_pf", "prn_owner", "owner", "subtree"),
    );

    expect(
      reason(() => assertMayAdminister(index, forest, "d_prod", "prn_member")),
    ).toBe("control_widen");
    expect(assertMayAdminister(index, forest, "d_prod", "prn_owner").role).toBe(
      "owner",
    );
  });

  it("refuses a second controlling principal in a personal project", () => {
    const forest = estate("personal");
    let index = insertControl(
      emptyControlIndex(),
      forest,
      grant("c_me", "d_pf", "prn_me", "owner", "subtree"),
    );
    index = insertControl(
      index,
      forest,
      grant("c_me_prod", "d_prod", "prn_me", "owner", "subtree"),
    );

    expect(
      reason(() =>
        insertControl(
          index,
          forest,
          grant("c_them", "d_prod", "prn_them", "member", "domain_only"),
        ),
      ),
    ).toBe("personal_sharing");
    expect(
      reason(() =>
        insertDelegatedControl(
          index,
          forest,
          "prn_me",
          grant("c_them", "d_prod", "prn_them", "member", "subtree"),
        ),
      ),
    ).toBe("personal_sharing");
  });

  it("refuses control for a domain that is not in the forest", () => {
    const forest = estate("standard");
    expect(
      reason(() =>
        insertControl(
          emptyControlIndex(),
          forest,
          grant("c_x", "d_missing", "prn_me", "owner", "subtree"),
        ),
      ),
    ).toBe("not_found");
  });

  it("keeps the role ladder a ladder", () => {
    expect(roleCovers("owner", "admin")).toBe(true);
    expect(roleCovers("admin", "member")).toBe(true);
    expect(roleCovers("member", "admin")).toBe(false);
    expect(canAdminister("admin")).toBe(true);
    expect(canAdminister("member")).toBe(false);
    expect(canTransferOwnership("owner")).toBe(true);
    expect(canTransferOwnership("admin")).toBe(false);
  });
});

describe("cross-plane bridge", () => {
  it("freezes the wire strings the Rust plane asserts against its serde output", () => {
    expect([...DOMAIN_ROLE_WIRE]).toEqual(["member", "admin", "owner"]);
    expect([...DOMAIN_SCOPE_WIRE]).toEqual(["domain_only", "subtree"]);
    expect([...DOMAIN_INHERITANCE_WIRE]).toEqual(["inherit", "isolated"]);
    expect([...DOMAIN_LIFETIME_WIRE]).toEqual(["permanent", "temporary"]);
    expect([...DOMAIN_PROJECT_KIND_WIRE]).toEqual([
      "personal",
      "standard",
      "temporary",
    ]);
  });

  it("freezes the refusal vocabulary shared with DomainError::AccessDomain*", () => {
    expect([...ACCESS_DOMAIN_REFUSALS]).toEqual([
      "realm_mismatch",
      "cycle",
      "invalid",
      "not_found",
      "conflict",
      "depth_exceeded",
      "lifetime",
      "expired",
      "control_widen",
      "personal_sharing",
      "vault_binding",
    ]);
  });

  it("maps the project and organization ladders without a fourth vocabulary", () => {
    for (const role of ["owner", "admin", "member"] as const) {
      expect(projectRoleFromDomainRole(domainRoleFromProjectRole(role))).toBe(
        role,
      );
      expect(
        organizationRoleFromDomainRole(domainRoleFromOrganizationRole(role)),
      ).toBe(role);
    }
  });
});
