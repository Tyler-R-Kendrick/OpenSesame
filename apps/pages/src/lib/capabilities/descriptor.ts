/**
 * Authoring helper for catalog descriptors. The result is plain data — no
 * callbacks, no feature imports — so `buildCatalog` can digest it and a
 * consent receipt can bind it. Defaults are the *narrowest* claim: a
 * document-only capability with no egress, no permissions, no key access, no
 * service, no worker constraint, no reload, no item kinds. Anything wider is
 * declared explicitly where the code actually does it.
 */

import type {
  CapabilityDescriptor,
  CapabilityId,
  ModuleId,
} from "@opensesame/capability-composition";

/** A descriptor before `buildCatalog` computes its exposure digest. */
export type AuthoredDescriptor = Omit<CapabilityDescriptor, "exposureDigest">;

type Overrides = Partial<
  Omit<AuthoredDescriptor, "id" | "tier" | "title" | "summary">
>;

const NARROWEST: Omit<AuthoredDescriptor, "id" | "tier" | "title" | "summary"> =
  {
    descriptorVersion: 1,
    dependencies: [],
    alternatives: [],
    operationIds: [],
    moduleIds: [],
    environments: ["document"],
    egress: [],
    browserPermissions: [],
    keyAccess: "none",
    requiresService: false,
    offlineLimits: "",
    workerGraphConstraint: null,
    requiresDocumentReload: false,
    itemKinds: [],
  };

/** Module id of a capability's document runtime (`<id>/runtime`). */
export function runtimeModule(id: CapabilityId): ModuleId {
  return `${id}/runtime`;
}

/** Module id of a capability's service-worker part (`<id>/worker`). */
export function workerModule(id: CapabilityId): ModuleId {
  return `${id}/worker`;
}

/**
 * A core descriptor: statically linked into the entry, so it has no
 * loadable module and the loader never fetches it.
 */
export function core(
  id: CapabilityId,
  title: string,
  summary: string,
  overrides: Overrides = {},
): AuthoredDescriptor {
  return { ...NARROWEST, ...overrides, id, tier: "core", title, summary };
}

/**
 * An optional descriptor. Its runtime module is always `<id>/runtime`
 * (ownership.md §4.3); extra module ids (a worker part) are appended.
 */
export function optional(
  id: CapabilityId,
  title: string,
  summary: string,
  overrides: Overrides = {},
): AuthoredDescriptor {
  const extra = overrides.moduleIds ?? [];
  return {
    ...NARROWEST,
    ...overrides,
    moduleIds: [runtimeModule(id), ...extra],
    id,
    tier: "optional",
    title,
    summary,
  };
}
