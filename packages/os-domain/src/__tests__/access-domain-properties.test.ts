import { describe, expect, it } from "vitest";
import {
  type AccessDomainForest,
  type AccessRealm,
  MAX_DOMAIN_DEPTH,
  allDomains,
  ancestorsOf,
  assertAcyclic,
  createDomain,
  emptyForest,
  insertDomain,
  isInSubtreeOf,
  isRoot,
  makeAccessDomain,
  pathOf,
  removeSubtree,
  reparentDomain,
  requireDomain,
} from "../access-domain/index.js";
import { DomainError } from "../errors.js";

const NOW = new Date("2026-03-01T00:00:00Z");
const REALM: AccessRealm = { projectId: "prj_alpha", projectKind: "standard" };

/**
 * A seeded generator, so a failure is reproducible from the seed printed in the
 * assertion message. `fast-check` is not a dependency of this package and
 * adding one to a shared lockfile for four properties is not worth it.
 */
function lcg(seed: number): () => number {
  let state = (seed * 2654435761) % 4294967296;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/**
 * Build a forest by giving each new node a parent chosen from the nodes already
 * in it. Slugs are unique per index, so the only legitimate refusal is the
 * depth cap; a node the plan wanted but the forest would not take is left out,
 * which is what a caller would do.
 */
/** A forest a seed produced, and the ids that actually went in. */
interface BuiltForest {
  readonly forest: AccessDomainForest;
  readonly created: string[];
}

function build(seed: number, size: number): BuiltForest {
  const random = lcg(seed);
  let forest = emptyForest(REALM);
  const created: string[] = [];
  for (let index = 0; index < size; index += 1) {
    const id = `d_${index}`;
    const slug = `d${index}`;
    const asRoot = created.length === 0 || random() < 0.25;
    const parentId = asRoot
      ? undefined
      : created[Math.floor(random() * created.length)];
    try {
      forest = createDomain(
        forest,
        parentId === undefined
          ? { id, slug, displayName: slug, createdAt: NOW }
          : { id, parentId, slug, displayName: slug, createdAt: NOW },
      );
      created.push(id);
    } catch (error) {
      // Only the depth cap may refuse here; anything else is a real failure.
      if (!(error instanceof DomainError)) throw error;
      expect(String(error.details.reason)).toBe("depth_exceeded");
    }
  }
  return { forest, created };
}

/** Every parent walk terminates, repeats nothing, and ends at a root. */
function expectWalksTerminate(forest: AccessDomainForest, seed: number): void {
  for (const domain of allDomains(forest)) {
    const ancestors = ancestorsOf(forest, domain.id);
    expect(new Set(ancestors).size, `seed ${seed}`).toBe(ancestors.length);
    expect(ancestors, `seed ${seed}`).not.toContain(domain.id);
    const top = ancestors.at(-1);
    if (top === undefined) {
      expect(isRoot(domain), `seed ${seed}`).toBe(true);
    } else {
      expect(isRoot(requireDomain(forest, top)), `seed ${seed}`).toBe(true);
    }
    expect(ancestors.length + 1, `seed ${seed}`).toBeLessThanOrEqual(
      MAX_DOMAIN_DEPTH,
    );
  }
}

const SEEDS = Array.from({ length: 40 }, (_, index) => index + 1);

describe("access domain forest properties", () => {
  it("is acyclic however it was assembled", () => {
    for (const seed of SEEDS) {
      const { forest, created } = build(seed, 20);
      expect(() => assertAcyclic(forest)).not.toThrow();
      expect(allDomains(forest)).toHaveLength(created.length);
      expectWalksTerminate(forest, seed);
    }
  });

  it("gives every domain its own path", () => {
    for (const seed of SEEDS) {
      const { forest } = build(seed, 20);
      const paths = new Set<string>();
      for (const domain of allDomains(forest)) {
        const path = pathOf(forest, domain.id);
        expect(paths.has(path), `seed ${seed} path ${path}`).toBe(false);
        paths.add(path);
      }
    }
  });

  it("accepts a move exactly when the new parent is outside the moved subtree", () => {
    for (const seed of SEEDS) {
      let { forest, created } = build(seed, 16);
      if (created.length === 0) continue;
      const random = lcg(seed + 1000);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const subject = created[Math.floor(random() * created.length)];
        if (subject === undefined) continue;
        const toRoot = random() < 0.2;
        const parentId = toRoot
          ? undefined
          : created[Math.floor(random() * created.length)];
        const wouldCycle =
          parentId !== undefined && isInSubtreeOf(forest, parentId, subject);
        let refusal: string | undefined;
        let moved = forest;
        try {
          moved = reparentDomain(forest, subject, parentId);
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          refusal = String(error.details.reason);
        }
        if (wouldCycle) {
          expect(refusal, `seed ${seed}`).toBe("cycle");
        } else {
          // The remaining refusals are the depth cap and a sibling slug clash;
          // neither may be reported as a cycle.
          expect(refusal, `seed ${seed}`).not.toBe("cycle");
        }
        forest = refusal === undefined ? moved : forest;
        expect(() => assertAcyclic(forest), `seed ${seed}`).not.toThrow();
        expectWalksTerminate(forest, seed);
      }
    }
  });

  it("never leaves a dangling parent after removing a subtree", () => {
    for (const seed of SEEDS) {
      const { forest, created } = build(seed, 16);
      if (created.length === 0) continue;
      const random = lcg(seed + 2000);
      const victim = created[Math.floor(random() * created.length)];
      if (victim === undefined) continue;
      const outcome = removeSubtree(forest, victim);
      expect(outcome.removed.length, `seed ${seed}`).toBeGreaterThan(0);
      for (const domain of allDomains(outcome.forest)) {
        if (domain.parentId === undefined) continue;
        expect(
          outcome.forest.nodes.has(domain.parentId),
          `seed ${seed} orphan ${domain.id}`,
        ).toBe(true);
      }
      expect(() => assertAcyclic(outcome.forest)).not.toThrow();
      expectWalksTerminate(outcome.forest, seed);
    }
  });

  it("never admits a node from another realm", () => {
    for (const seed of SEEDS.slice(0, 5)) {
      const { forest } = build(seed, 12);
      const stranger = makeAccessDomain({
        id: "d_stranger",
        realm: { projectId: "prj_beta", projectKind: "standard" },
        slug: "stranger",
        displayName: "Stranger",
        createdAt: NOW,
      });
      expect(() => insertDomain(forest, stranger)).toThrow(DomainError);
    }
  });

  it("reports a rehydrated cycle rather than walking it", () => {
    // A cycle can only arrive this way — the mutations refuse to make one — so
    // this is what a forest that lost the invariant in storage looks like.
    let forest = createDomain(emptyForest(REALM), {
      id: "d_upper",
      slug: "upper",
      displayName: "Upper",
      createdAt: NOW,
    });
    forest = createDomain(forest, {
      id: "d_lower",
      parentId: "d_upper",
      slug: "lower",
      displayName: "Lower",
      createdAt: NOW,
    });
    const nodes = new Map(forest.nodes);
    const upper = requireDomain(forest, "d_upper");
    nodes.set("d_upper", { ...upper, parentId: "d_lower" });
    const cyclic: AccessDomainForest = { realm: REALM, nodes };

    expect(() => ancestorsOf(cyclic, "d_lower")).toThrow(DomainError);
    expect(() => assertAcyclic(cyclic)).toThrow(DomainError);
    expect(() => pathOf(cyclic, "d_upper")).toThrow(DomainError);
  });
});
