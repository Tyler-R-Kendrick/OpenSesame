import type { AccessDomain } from "./node.js";
import { assertBindingMatchesRealm, isRoot } from "./node.js";
import type { AccessRealm } from "./realm.js";
import { assertSameBoundary, refuseAccessDomain } from "./realm.js";
import type { DomainLifetime } from "./temporal.js";
import {
  assertLifetimeActive,
  assertLifetimeWithin,
  deadlineOf,
  isExpired,
} from "./temporal.js";

/**
 * How deep a domain path may go, counting the root as level 1.
 *
 * Eight is an estate a person can still read out loud: organization, division,
 * team, service, environment, and room to spare.
 */
export const MAX_DOMAIN_DEPTH = 8;

/**
 * Every access domain in one realm.
 *
 * Immutable by convention: `insertDomain` and everything in `mutate.ts` answer
 * with a new forest rather than editing this one, so a caller holding a forest
 * holds a shape that already passed every invariant.
 */
export interface AccessDomainForest {
  readonly realm: AccessRealm;
  readonly nodes: ReadonlyMap<string, AccessDomain>;
}

export function emptyForest(realm: AccessRealm): AccessDomainForest {
  return { realm, nodes: new Map() };
}

export function domainCount(forest: AccessDomainForest): number {
  return forest.nodes.size;
}

export function hasDomain(forest: AccessDomainForest, id: string): boolean {
  return forest.nodes.has(id);
}

export function getDomain(
  forest: AccessDomainForest,
  id: string,
): AccessDomain | undefined {
  return forest.nodes.get(id);
}

/** Look a domain up or say which one was missing. */
export function requireDomain(
  forest: AccessDomainForest,
  id: string,
): AccessDomain {
  const domain = forest.nodes.get(id);
  if (domain === undefined) {
    throw refuseAccessDomain(
      "not_found",
      `No access domain ${id} in this realm`,
      { id },
    );
  }
  return domain;
}

/** Every domain, in insertion order. */
export function allDomains(forest: AccessDomainForest): AccessDomain[] {
  return [...forest.nodes.values()];
}

/**
 * Add a domain, checking every structural rule, and answer with a new forest.
 *
 * The realm check here is what makes cross-realm reparenting unreachable: a
 * domain lifted out of one realm's forest can never be admitted to another's,
 * so its project — and the `projectId` sealed into its vault's AEAD associated
 * data — is fixed for the domain's whole life (ADR 0038).
 *
 * Acyclicity needs no separate check on this path. A node arriving with an id
 * nothing points at yet, under a parent already in an acyclic forest, cannot
 * close a cycle. Reparenting is the only other operation that changes an edge,
 * and it carries its own subtree check.
 */
export function insertDomain(
  forest: AccessDomainForest,
  domain: AccessDomain,
): AccessDomainForest {
  assertSameBoundary(forest.realm, domain.realm);
  if (forest.nodes.has(domain.id)) {
    throw refuseAccessDomain(
      "conflict",
      `Access domain ${domain.id} is already in this forest`,
      { id: domain.id },
    );
  }
  if (domain.vaultBinding !== undefined) {
    assertBindingMatchesRealm(domain.vaultBinding, forest.realm);
  }
  if (domain.parentId !== undefined) {
    const parent = requireDomain(forest, domain.parentId);
    assertLifetimeWithin(domain.lifetime, parent.lifetime);
    const depth = depthOf(forest, parent.id) + 1;
    if (depth > MAX_DOMAIN_DEPTH) {
      throw refuseAccessDomain(
        "depth_exceeded",
        `Access domain depth ${depth} exceeds ${MAX_DOMAIN_DEPTH}`,
        { depth: String(depth) },
      );
    }
  }
  assertSlugFree(forest, domain.parentId, domain.slug);
  const nodes = new Map(forest.nodes);
  nodes.set(domain.id, domain);
  return { realm: forest.realm, nodes };
}

/** The forest's roots, in insertion order. */
export function rootDomains(forest: AccessDomainForest): string[] {
  return allDomains(forest)
    .filter(isRoot)
    .map((domain) => domain.id);
}

/** The direct children of `id`. Empty for a leaf and for an unknown id. */
export function childrenOf(forest: AccessDomainForest, id: string): string[] {
  return allDomains(forest)
    .filter((domain) => domain.parentId === id)
    .map((domain) => domain.id);
}

/**
 * The ancestors of `id`, nearest parent first, ending at a root.
 *
 * Walks with a visited set and reports a cycle rather than looping, so a forest
 * rehydrated from storage that somehow *is* cyclic fails loudly on the first
 * read instead of hanging a request.
 */
export function ancestorsOf(forest: AccessDomainForest, id: string): string[] {
  const seen = new Set<string>([id]);
  const chain: string[] = [];
  let cursor = requireDomain(forest, id).parentId;
  while (cursor !== undefined) {
    if (seen.has(cursor)) {
      throw refuseAccessDomain("cycle", `Walk from ${id} revisits ${cursor}`, {
        from: id,
        at: cursor,
      });
    }
    seen.add(cursor);
    chain.push(cursor);
    cursor = requireDomain(forest, cursor).parentId;
  }
  return chain;
}

/** How deep `id` sits, counting itself. A root is 1. */
export function depthOf(forest: AccessDomainForest, id: string): number {
  return ancestorsOf(forest, id).length + 1;
}

/** The readable path to `id`, root slug first: `platform/prod`. */
export function pathOf(forest: AccessDomainForest, id: string): string {
  const slugs = [requireDomain(forest, id).slug];
  for (const ancestor of ancestorsOf(forest, id)) {
    slugs.push(requireDomain(forest, ancestor).slug);
  }
  return slugs.reverse().join("/");
}

/** `id` and everything beneath it, breadth first. */
export function subtreeOf(forest: AccessDomainForest, id: string): string[] {
  requireDomain(forest, id);
  const collected = [id];
  const frontier = [id];
  const seen = new Set<string>([id]);
  while (frontier.length > 0) {
    const current = frontier.pop();
    if (current === undefined) break;
    for (const child of childrenOf(forest, current)) {
      // A cycle would make this loop forever; `seen` turns it into a finite
      // answer that `assertAcyclic` reports properly.
      if (seen.has(child)) continue;
      seen.add(child);
      collected.push(child);
      frontier.push(child);
    }
  }
  return collected;
}

/** Whether `id` is `ancestor` or sits beneath it. */
export function isInSubtreeOf(
  forest: AccessDomainForest,
  id: string,
  ancestor: string,
): boolean {
  return subtreeOf(forest, ancestor).includes(id);
}

/** How many levels the subtree rooted at `id` spans, `id` itself being 1. */
export function subtreeHeight(forest: AccessDomainForest, id: string): number {
  const base = depthOf(forest, id);
  let height = 1;
  for (const member of subtreeOf(forest, id)) {
    height = Math.max(height, depthOf(forest, member) + 1 - base);
  }
  return height;
}

/** Prove the whole forest is a forest. */
export function assertAcyclic(forest: AccessDomainForest): void {
  for (const domain of allDomains(forest)) {
    assertSameBoundary(forest.realm, domain.realm);
    const depth = depthOf(forest, domain.id);
    if (depth > MAX_DOMAIN_DEPTH) {
      throw refuseAccessDomain(
        "depth_exceeded",
        `Access domain depth ${depth} exceeds ${MAX_DOMAIN_DEPTH}`,
        { id: domain.id, depth: String(depth) },
      );
    }
  }
}

/**
 * Every deadline in the forest, earliest first.
 *
 * This is what a lifecycle scanner reads (ADR 0074). Ids and timestamps only.
 */
export function domainDeadlines(
  forest: AccessDomainForest,
): { id: string; expiresAt: Date }[] {
  const due: { id: string; expiresAt: Date }[] = [];
  for (const domain of allDomains(forest)) {
    const expiresAt = deadlineOf(domain.lifetime);
    if (expiresAt !== undefined) due.push({ id: domain.id, expiresAt });
  }
  return due.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
}

/** The domains whose own deadline has passed at `now`. */
export function expiredDomains(
  forest: AccessDomainForest,
  now: Date,
): string[] {
  return allDomains(forest)
    .filter((domain) => isExpired(domain.lifetime, now))
    .map((domain) => domain.id);
}

/**
 * Whether `id` can be reached at `now`: itself live, and every ancestor live
 * too.
 *
 * An expired parent is not a cosmetic state. Its subtree is gone with it, so a
 * still-dated child must not answer as reachable in the window before a pruner
 * runs.
 */
export function assertReachable(
  forest: AccessDomainForest,
  id: string,
  now: Date,
): void {
  assertLifetimeActive(requireDomain(forest, id).lifetime, now);
  for (const ancestor of ancestorsOf(forest, id)) {
    assertLifetimeActive(requireDomain(forest, ancestor).lifetime, now);
  }
}

/**
 * Refuse a slug a sibling already holds. `except` is the node being renamed or
 * moved, so it does not collide with itself.
 */
export function assertSlugFree(
  forest: AccessDomainForest,
  parentId: string | undefined,
  slug: string,
  except?: string,
): void {
  const taken = allDomains(forest).some(
    (domain) =>
      domain.parentId === parentId &&
      domain.slug === slug &&
      domain.id !== except,
  );
  if (taken) {
    throw refuseAccessDomain(
      "conflict",
      `Slug "${slug}" is already taken among these siblings`,
      { slug },
    );
  }
}

/** Replace one node, keeping the rest of the forest as it was. */
export function withDomain(
  forest: AccessDomainForest,
  domain: AccessDomain,
): AccessDomainForest {
  const nodes = new Map(forest.nodes);
  nodes.set(domain.id, domain);
  return { realm: forest.realm, nodes };
}

/** The lifetime of `id`'s parent, or permanent when it is a root. */
export function parentLifetime(
  forest: AccessDomainForest,
  parentId: string | undefined,
): DomainLifetime | undefined {
  if (parentId === undefined) return undefined;
  return requireDomain(forest, parentId).lifetime;
}
