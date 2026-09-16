import { describe, expect, it } from "vitest";
import {
  type AccessDomainForest,
  type AccessRealm,
  MAX_DOMAIN_DEPTH,
  assertAcyclic,
  assertReachable,
  bindVault,
  createDomain,
  domainDeadlines,
  emptyForest,
  getDomain,
  insertDomain,
  makeAccessDomain,
  pathOf,
  pruneExpiredDomains,
  removeLeafDomain,
  removeSubtree,
  renameDomain,
  reparentDomain,
  rootDomains,
  setLifetime,
  temporaryUntil,
} from "../access-domain/index.js";
import { DomainError } from "../errors.js";

const NOW = new Date("2026-03-01T00:00:00Z");

function later(days: number): Date {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
}

function standardRealm(projectId = "prj_alpha"): AccessRealm {
  return { projectId, projectKind: "standard" };
}

function withRoot(
  forest: AccessDomainForest,
  id: string,
  slug: string,
): AccessDomainForest {
  return createDomain(forest, {
    id,
    slug,
    displayName: slug,
    createdAt: NOW,
  });
}

function withChild(
  forest: AccessDomainForest,
  id: string,
  parentId: string,
  slug: string,
): AccessDomainForest {
  return createDomain(forest, {
    id,
    parentId,
    slug,
    displayName: slug,
    createdAt: NOW,
  });
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

describe("access domain forest", () => {
  it("holds several roots in one realm, each with its own tree", () => {
    let forest = withRoot(emptyForest(standardRealm()), "d_pf", "platform");
    forest = withRoot(forest, "d_rs", "research");
    forest = withChild(forest, "d_prod", "d_pf", "prod");

    expect(rootDomains(forest)).toEqual(["d_pf", "d_rs"]);
    expect(pathOf(forest, "d_prod")).toBe("platform/prod");
    expect(() => assertAcyclic(forest)).not.toThrow();
  });

  it("refuses a domain from another realm, so a move across projects is impossible", () => {
    const forest = withRoot(emptyForest(standardRealm()), "d_pf", "platform");
    const stranger = makeAccessDomain({
      id: "d_other",
      realm: standardRealm("prj_beta"),
      slug: "platform",
      displayName: "Platform",
      createdAt: NOW,
    });
    expect(reason(() => insertDomain(forest, stranger))).toBe("realm_mismatch");

    const lifted = removeSubtree(forest, "d_pf");
    const destination = emptyForest(standardRealm("prj_beta"));
    for (const domain of lifted.removed) {
      expect(reason(() => insertDomain(destination, domain))).toBe(
        "realm_mismatch",
      );
    }
  });

  it("keeps sibling slugs unique but lets cousins share one", () => {
    let forest = withRoot(emptyForest(standardRealm()), "d_pf", "platform");
    forest = withRoot(forest, "d_rs", "research");
    forest = withChild(forest, "d_prod", "d_pf", "prod");

    expect(reason(() => withChild(forest, "d_dup", "d_pf", "prod"))).toBe(
      "conflict",
    );
    expect(() => withChild(forest, "d_rprod", "d_rs", "prod")).not.toThrow();
    expect(reason(() => withRoot(forest, "d_dup2", "platform"))).toBe(
      "conflict",
    );
  });

  it("renames within sibling uniqueness and rewrites the path", () => {
    let forest = withRoot(emptyForest(standardRealm()), "d_pf", "platform");
    forest = withChild(forest, "d_prod", "d_pf", "prod");
    forest = withChild(forest, "d_stg", "d_pf", "staging");

    expect(reason(() => renameDomain(forest, "d_prod", "staging", "S"))).toBe(
      "conflict",
    );
    forest = renameDomain(forest, "d_prod", "production", "Production");
    expect(pathOf(forest, "d_prod")).toBe("platform/production");
  });

  it("caps depth on insert and counts the whole subtree on a move", () => {
    let forest = emptyForest(standardRealm());
    forest = withRoot(forest, "d_1", "level-1");
    for (let level = 2; level <= MAX_DOMAIN_DEPTH; level += 1) {
      forest = withChild(
        forest,
        `d_${level}`,
        `d_${level - 1}`,
        `level-${level}`,
      );
    }
    expect(
      reason(() =>
        withChild(forest, "d_over", `d_${MAX_DOMAIN_DEPTH}`, "over"),
      ),
    ).toBe("depth_exceeded");

    forest = withRoot(forest, "d_other", "other");
    forest = withChild(forest, "d_branch", "d_other", "branch");
    expect(
      reason(() => reparentDomain(forest, "d_branch", `d_${MAX_DOMAIN_DEPTH}`)),
    ).toBe("depth_exceeded");
  });

  it("refuses a move into the moved subtree and accepts one outside it", () => {
    let forest = withRoot(emptyForest(standardRealm()), "d_pf", "platform");
    forest = withChild(forest, "d_prod", "d_pf", "prod");
    forest = withChild(forest, "d_eu", "d_prod", "eu");
    forest = withRoot(forest, "d_rs", "research");

    expect(reason(() => reparentDomain(forest, "d_pf", "d_eu"))).toBe("cycle");
    expect(reason(() => reparentDomain(forest, "d_pf", "d_pf"))).toBe("cycle");

    const moved = reparentDomain(forest, "d_prod", "d_rs");
    expect(pathOf(moved, "d_prod")).toBe("research/prod");
    expect(pathOf(moved, "d_eu")).toBe("research/prod/eu");
    expect(() => assertAcyclic(moved)).not.toThrow();

    const promoted = reparentDomain(moved, "d_prod");
    expect(getDomain(promoted, "d_prod")?.parentId).toBeUndefined();
    expect(pathOf(promoted, "d_prod")).toBe("prod");
  });

  it("carries a vault binding through a move without changing its project", () => {
    const realm = standardRealm();
    let forest = withRoot(emptyForest(realm), "d_pf", "platform");
    forest = withRoot(forest, "d_rs", "research");
    forest = insertDomain(
      forest,
      makeAccessDomain({
        id: "d_prod",
        realm,
        parentId: "d_pf",
        slug: "prod",
        displayName: "Prod",
        createdAt: NOW,
        vaultBinding: bindVault(realm, "vault_1"),
      }),
    );

    const moved = reparentDomain(forest, "d_prod", "d_rs");
    expect(getDomain(moved, "d_prod")?.vaultBinding?.projectId).toBe(
      realm.projectId,
    );
  });

  it("refuses a vault sealed against another project", () => {
    const realm = standardRealm();
    const forest = emptyForest(realm);
    expect(
      reason(() =>
        insertDomain(
          forest,
          makeAccessDomain({
            id: "d_pf",
            realm,
            slug: "platform",
            displayName: "Platform",
            createdAt: NOW,
            vaultBinding: bindVault(standardRealm("prj_beta"), "vault_1"),
          }),
        ),
      ),
    ).toBe("vault_binding");
  });

  it("removes a parent with its children or not at all", () => {
    let forest = withRoot(emptyForest(standardRealm()), "d_pf", "platform");
    forest = withChild(forest, "d_prod", "d_pf", "prod");
    forest = withChild(forest, "d_eu", "d_prod", "eu");

    expect(reason(() => removeLeafDomain(forest, "d_pf"))).toBe("conflict");
    const outcome = removeSubtree(forest, "d_pf");
    expect(outcome.removed.map((domain) => domain.id)).toEqual([
      "d_eu",
      "d_prod",
      "d_pf",
    ]);
    expect(rootDomains(outcome.forest)).toEqual([]);
  });
});

describe("temporary access domains", () => {
  it("refuses a permanent domain under a temporary one, and a child that outlives its parent", () => {
    const realm = standardRealm();
    let forest = insertDomain(
      emptyForest(realm),
      makeAccessDomain({
        id: "d_visit",
        realm,
        slug: "visit",
        displayName: "Visit",
        createdAt: NOW,
        lifetime: temporaryUntil(later(2)),
      }),
    );
    expect(
      reason(() => withChild(forest, "d_forever", "d_visit", "forever")),
    ).toBe("lifetime");
    expect(
      reason(() =>
        insertDomain(
          forest,
          makeAccessDomain({
            id: "d_later",
            realm,
            parentId: "d_visit",
            slug: "later",
            displayName: "Later",
            createdAt: NOW,
            lifetime: temporaryUntil(later(3)),
          }),
        ),
      ),
    ).toBe("lifetime");

    forest = insertDomain(
      forest,
      makeAccessDomain({
        id: "d_inner",
        realm,
        parentId: "d_visit",
        slug: "inner",
        displayName: "Inner",
        createdAt: NOW,
        lifetime: temporaryUntil(later(1)),
      }),
    );
    expect(domainDeadlines(forest).map((entry) => entry.id)).toEqual([
      "d_inner",
      "d_visit",
    ]);
  });

  it("treats a live child under a spent parent as unreachable, then prunes both", () => {
    const realm = standardRealm();
    let forest = insertDomain(
      emptyForest(realm),
      makeAccessDomain({
        id: "d_visit",
        realm,
        slug: "visit",
        displayName: "Visit",
        createdAt: NOW,
        lifetime: temporaryUntil(later(2)),
      }),
    );
    forest = insertDomain(
      forest,
      makeAccessDomain({
        id: "d_inner",
        realm,
        parentId: "d_visit",
        slug: "inner",
        displayName: "Inner",
        createdAt: NOW,
        lifetime: temporaryUntil(later(1)),
      }),
    );
    forest = withRoot(forest, "d_keep", "keeper");

    expect(() => assertReachable(forest, "d_inner", NOW)).not.toThrow();
    expect(reason(() => assertReachable(forest, "d_inner", later(3)))).toBe(
      "expired",
    );

    const pruned = pruneExpiredDomains(forest, later(3));
    expect(pruned.removed).toHaveLength(2);
    expect(rootDomains(pruned.forest)).toEqual(["d_keep"]);
  });

  it("refuses a lifetime that would escape a parent or orphan a child", () => {
    const realm = standardRealm();
    let forest = insertDomain(
      emptyForest(realm),
      makeAccessDomain({
        id: "d_outer",
        realm,
        slug: "outer",
        displayName: "Outer",
        createdAt: NOW,
        lifetime: temporaryUntil(later(4)),
      }),
    );
    forest = insertDomain(
      forest,
      makeAccessDomain({
        id: "d_inner",
        realm,
        parentId: "d_outer",
        slug: "inner",
        displayName: "Inner",
        createdAt: NOW,
        lifetime: temporaryUntil(later(2)),
      }),
    );

    expect(
      reason(() => setLifetime(forest, "d_outer", temporaryUntil(later(1)))),
    ).toBe("lifetime");
    expect(
      reason(() => setLifetime(forest, "d_inner", { kind: "permanent" })),
    ).toBe("lifetime");
    expect(() =>
      setLifetime(forest, "d_inner", temporaryUntil(later(4))),
    ).not.toThrow();
  });
});
