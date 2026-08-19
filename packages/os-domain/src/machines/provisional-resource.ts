import { invalidTransition } from "../errors.js";
import type { Clock, Resource, ResourceState } from "../types.js";

/**
 * Provisional resource lifecycle:
 * provisional -> active | expired | quarantined
 * expired -> deleting -> deleted
 */
const ALLOWED: ReadonlyMap<ResourceState, ReadonlySet<ResourceState>> = new Map(
  [
    ["provisional", new Set(["active", "expired", "quarantined"])],
    ["active", new Set(["expired", "deleting", "quarantined"])],
    ["expired", new Set(["deleting", "quarantined"])],
    ["quarantined", new Set(["deleting", "expired"])],
    ["deleting", new Set(["deleted"])],
    ["deleted", new Set()],
  ],
);

export function canTransitionResource(
  from: ResourceState,
  to: ResourceState,
): boolean {
  return ALLOWED.get(from)?.has(to) ?? false;
}

function apply(
  resource: Resource,
  to: ResourceState,
  patch: Partial<Resource> = {},
): Resource {
  if (!canTransitionResource(resource.state, to)) {
    throw invalidTransition(resource.state, to, "provisional_resource");
  }
  return {
    ...resource,
    ...patch,
    state: to,
    id: resource.id,
    version: resource.version + 1,
    updatedAt: patch.updatedAt ?? new Date(),
  };
}

export function activateProvisionalResource(
  resource: Resource,
  now: Date = new Date(),
): Resource {
  return apply(resource, "active", { updatedAt: now });
}

export function expireProvisionalResource(
  resource: Resource,
  now: Date = new Date(),
): Resource {
  return apply(resource, "expired", { updatedAt: now });
}

export function quarantineResource(
  resource: Resource,
  now: Date = new Date(),
): Resource {
  return apply(resource, "quarantined", { updatedAt: now });
}

export function beginResourceDeletion(
  resource: Resource,
  now: Date = new Date(),
): Resource {
  return apply(resource, "deleting", { updatedAt: now });
}

export function completeResourceDeletion(
  resource: Resource,
  now: Date = new Date(),
): Resource {
  return apply(resource, "deleted", { updatedAt: now });
}

export function maybeExpireProvisionalResource(
  resource: Resource,
  clock: Clock = () => new Date(),
): Resource {
  const now = clock();
  if (resource.state !== "provisional" && resource.state !== "active") {
    return resource;
  }
  if (resource.expiresAt && now >= resource.expiresAt) {
    return expireProvisionalResource(resource, now);
  }
  return resource;
}
