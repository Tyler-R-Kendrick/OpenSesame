/**
 * Module, HTML-entry and public-file ownership (ownership.md §2, §4.3, §4.6).
 *
 * Every optional capability's document runtime is
 * `src/modules/<capability-id>/runtime.ts`; the push capability also owns the
 * worker variant source `src/sw-push.ts`. The build plugin (S07) reads this
 * map to generate the module table and to decide, in a hardened build, which
 * entries, files and worker variants are not emitted at all. The test asserts
 * every path here exists on disk, except those still listed as planned while
 * module owners (S11–S16) create them.
 */

import type {
  CapabilityId,
  DistributionContract,
  DistributionMode,
  ExecutionEnvironment,
  ModuleId,
  WorkerVariant,
} from "@opensesame/capability-composition";
import { CAPABILITY_CATALOG, optionalCapabilityIds } from "./catalog.js";
import { runtimeModule, workerModule } from "./descriptor.js";

export type ModuleOwnership = Readonly<{
  /** Repo path under apps/pages of the module's entry source. */
  entry: string;
  capability: CapabilityId;
  environments: readonly ExecutionEnvironment[];
}>;

function runtimeEntry(id: CapabilityId): ModuleOwnership {
  return {
    entry: `src/modules/${id}/runtime.ts`,
    capability: id,
    environments: ["document"],
  };
}

const PUSH = "notifications.web-push";

export const MODULE_OWNERSHIP: Readonly<Record<ModuleId, ModuleOwnership>> =
  Object.freeze({
    ...Object.fromEntries(
      optionalCapabilityIds().map((id) => [
        runtimeModule(id),
        runtimeEntry(id),
      ]),
    ),
    [workerModule(PUSH)]: {
      entry: "src/sw-push.ts",
      capability: PUSH,
      environments: ["service-worker"],
    },
  });

/**
 * Entries whose source is being created concurrently by module owners. The
 * ownership test asserts existence for every entry *not* listed here and
 * reports this list; an entry is removed from it the moment its file lands.
 * `telemetry.external` has no Pages code today at all — the module is the
 * only thing that will ever carry it.
 */
export const PLANNED_MODULE_ENTRIES: readonly string[] = [
  "vault.interop-formats",
  "access.authority",
  "identity.federation",
  "identity.ambient-sso",
  "identity.local-iam",
  "identity.siop",
  "identity.site-broker",
  "enterprise.directory-provisioning",
  "enterprise.ca-administration",
  "agents.webmcp",
  "support.guided-help",
  "support.local-ai",
  "support.remote-ai",
  "notifications.web-push",
  "telemetry.external",
].map((id) => runtimeEntry(id).entry);

/** Secondary HTML entries (vite `rollupOptions.input`) and who owns them. */
export const HTML_ENTRY_OWNERSHIP: Readonly<Record<string, CapabilityId>> =
  Object.freeze({
    // MSAL v5 redirect bridge: never emitted without ambient SSO.
    "auth/redirect.html": "identity.ambient-sso",
  });

/**
 * Files under `public/` and the capability that serves them. `auth.js` and
 * `static-auth/**` are the `@opensesame/static-auth` browser SDK builds a
 * *relying site* loads to sign in through this origin's broker popup
 * (`/broker/authorize`, ADR 0034): `auth.js` is the deprecated loopback
 * compatibility build, `static-auth/<version>/opensesame-auth.min.js` the
 * immutable hosted SDK, `static-auth/manifest.json` their SRI record. None of
 * them serves browser-local IAM (`signInLocalBrowser` is not in either
 * bundle), so they belong to the site broker, not to `identity.local-iam`.
 * A `null` owner is core: present in every build.
 */
export const PUBLIC_FILE_OWNERSHIP: Readonly<
  Record<string, CapabilityId | null>
> = Object.freeze({
  "icon.svg": null,
  "os-runtime-config.json": null,
  "security-profile.json": null,
  "auth.js": "identity.site-broker",
  "auth.js.sha384": "identity.site-broker",
  "static-auth/**": "identity.site-broker",
});

export const WORKER_VARIANTS: readonly WorkerVariant[] = [
  { id: "core-only", scriptPath: "sw.js", satisfies: [] },
  { id: "push", scriptPath: "sw-push.js", satisfies: ["push"] },
];

/** The base path every Pages build here is emitted under. */
export const DISTRIBUTION_BASE_PATH = "/OpenSesame/";

/**
 * The distribution a build that ships every owned module would declare —
 * the `rich-explicit` contract of ownership.md §4.6. Tests and the default
 * (profile-less) build resolve against it.
 */
export function distributionFromOwnership(
  mode: DistributionMode,
): DistributionContract {
  return {
    distributionId: `ownership-${mode}`,
    mode,
    capabilityIds: CAPABILITY_CATALOG.capabilities.map((entry) => entry.id),
    moduleIds: Object.keys(MODULE_OWNERSHIP).sort(),
    workerVariants: WORKER_VARIANTS,
    basePath: DISTRIBUTION_BASE_PATH,
  };
}

/** Module ids a capability owns, from the ownership map (not the catalog). */
export function modulesOwnedBy(id: CapabilityId): ModuleId[] {
  return Object.entries(MODULE_OWNERSHIP)
    .filter(([, ownership]) => ownership.capability === id)
    .map(([moduleId]) => moduleId)
    .sort();
}
