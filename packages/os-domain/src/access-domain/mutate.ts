import type { AccessDomainForest } from "./forest.js";
import {
  MAX_DOMAIN_DEPTH,
  assertSlugFree,
  childrenOf,
  depthOf,
  expiredDomains,
  hasDomain,
  insertDomain,
  isInSubtreeOf,
  parentLifetime,
  requireDomain,
  subtreeHeight,
  subtreeOf,
  withDomain,
} from "./forest.js";
import type { AccessDomain, InheritanceMode, NewAccessDomain } from "./node.js";
import {
  assertDisplayName,
  assertSlug,
  makeAccessDomain,
  reparented,
} from "./node.js";
import { refuseAccessDomain } from "./realm.js";
import type { DomainLifetime } from "./temporal.js";
import { assertLifetimeWellFormed, assertLifetimeWithin } from "./temporal.js";

/**
 * Create a domain in this forest's realm and insert it.
 *
 * The realm comes from the forest, never from the caller, so a create cannot
 * name a project the forest is not in.
 */
export function createDomain(
  forest: AccessDomainForest,
  input: Omit<NewAccessDomain, "realm">,
): AccessDomainForest {
  const domain = makeAccessDomain({ ...input, realm: forest.realm });
  return insertDomain(forest, domain);
}

/** Change a domain's slug and human-facing name. */
export function renameDomain(
  forest: AccessDomainForest,
  id: string,
  slug: string,
  displayName: string,
): AccessDomainForest {
  assertSlug(slug);
  assertDisplayName(displayName);
  const domain = requireDomain(forest, id);
  assertSlugFree(forest, domain.parentId, slug, id);
  return withDomain(forest, { ...domain, slug, displayName });
}

/** Break control inheritance at a domain, or restore it. */
export function setInheritance(
  forest: AccessDomainForest,
  id: string,
  inheritance: InheritanceMode,
): AccessDomainForest {
  const domain = requireDomain(forest, id);
  return withDomain(forest, { ...domain, inheritance });
}

/**
 * Change a domain's lifetime.
 *
 * Direct children are enough to check: each already fits inside this domain's
 * old lifetime, and "fits inside" is transitive, so a child that fits the new
 * one carries its own descendants with it.
 */
export function setLifetime(
  forest: AccessDomainForest,
  id: string,
  lifetime: DomainLifetime,
): AccessDomainForest {
  const domain = requireDomain(forest, id);
  assertLifetimeWellFormed(lifetime, domain.createdAt);
  const above = parentLifetime(forest, domain.parentId);
  if (above !== undefined) assertLifetimeWithin(lifetime, above);
  for (const child of childrenOf(forest, id)) {
    assertLifetimeWithin(requireDomain(forest, child).lifetime, lifetime);
  }
  return withDomain(forest, { ...domain, lifetime });
}

/**
 * Move a domain to a new parent, or up to a root.
 *
 * There is deliberately no cross-realm form of this: the forest is one realm,
 * so a move cannot change a domain's project, and with it the project its
 * vault's envelopes are sealed against (ADR 0038).
 */
export function reparentDomain(
  forest: AccessDomainForest,
  id: string,
  newParentId?: string,
): AccessDomainForest {
  const domain = requireDomain(forest, id);
  if (newParentId !== undefined) {
    if (newParentId === id) {
      throw refuseAccessDomain("cycle", `${id} cannot be its own parent`, {
        id,
      });
    }
    const parent = requireDomain(forest, newParentId);
    if (isInSubtreeOf(forest, newParentId, id)) {
      throw refuseAccessDomain(
        "cycle",
        `${newParentId} is inside the subtree of ${id}`,
        {
          id,
          parentId: newParentId,
        },
      );
    }
    assertLifetimeWithin(domain.lifetime, parent.lifetime);
    // The moved subtree's whole height counts, so a deep branch cannot be
    // smuggled under a deep parent.
    const reach = depthOf(forest, newParentId) + subtreeHeight(forest, id);
    if (reach > MAX_DOMAIN_DEPTH) {
      throw refuseAccessDomain(
        "depth_exceeded",
        `Access domain depth ${reach} exceeds ${MAX_DOMAIN_DEPTH}`,
        { depth: String(reach) },
      );
    }
  }
  assertSlugFree(forest, newParentId, domain.slug, id);
  return withDomain(forest, reparented(domain, newParentId));
}

/**
 * Remove a domain that has no children.
 *
 * Removing a parent by itself would leave its children pointing at nothing,
 * which is exactly the state every read here refuses to interpret.
 */
export function removeLeafDomain(
  forest: AccessDomainForest,
  id: string,
): AccessDomainForest {
  requireDomain(forest, id);
  const children = childrenOf(forest, id);
  if (children.length > 0) {
    throw refuseAccessDomain(
      "conflict",
      `${id} still has ${children.length} child domains`,
      { id, children: String(children.length) },
    );
  }
  const nodes = new Map(forest.nodes);
  nodes.delete(id);
  return { realm: forest.realm, nodes };
}

/** What a removal left behind, and what it took. */
export interface SubtreeRemoval {
  readonly forest: AccessDomainForest;
  readonly removed: AccessDomain[];
}

/** Remove a domain and everything beneath it, deepest first. */
export function removeSubtree(
  forest: AccessDomainForest,
  id: string,
): SubtreeRemoval {
  const members = subtreeOf(forest, id);
  const ordered = members
    .map((member) => ({ member, depth: depthOf(forest, member) }))
    .sort((a, b) => b.depth - a.depth)
    .map((entry) => entry.member);
  const nodes = new Map(forest.nodes);
  const removed: AccessDomain[] = [];
  for (const member of ordered) {
    const domain = nodes.get(member);
    if (domain !== undefined) {
      removed.push(domain);
      nodes.delete(member);
    }
  }
  return { forest: { realm: forest.realm, nodes }, removed };
}

/**
 * Remove every expired domain, with its subtree.
 *
 * Safe to cascade precisely because a permanent domain can never sit under a
 * temporary one: everything swept up here was itself on a clock.
 */
export function pruneExpiredDomains(
  forest: AccessDomainForest,
  now: Date,
): SubtreeRemoval {
  let current = forest;
  const removed: AccessDomain[] = [];
  for (const id of expiredDomains(forest, now)) {
    if (!hasDomain(current, id)) continue;
    const outcome = removeSubtree(current, id);
    current = outcome.forest;
    removed.push(...outcome.removed);
  }
  return { forest: current, removed };
}
