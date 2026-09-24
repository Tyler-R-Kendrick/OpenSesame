/**
 * The red-team mutation corpus (S23-E).
 *
 * Each entry breaks one product contract in the source and names the gate
 * that must notice. A gate that stays green under its mutation is not a
 * gate — it is a test that happens to pass, and the whole verification
 * system is then worth what it costs to run and nothing more.
 *
 * `find` must match exactly once in `file`; the runner refuses a mutation it
 * cannot apply unambiguously, so a refactor that moves the code fails loudly
 * rather than quietly skipping the check.
 */

const PAGES = "apps/pages";
const COMPOSITION = "packages/capability-composition";

/** A gate that must exit non-zero once the mutation is in place. */
const suite = (filter, ...paths) => ({
  kind: "exit",
  label: `${filter} ${paths.join(" ")}`,
  command: "pnpm",
  args: ["--filter", filter, "exec", "vitest", "run", ...paths],
});

/**
 * A gate that must *name* the mutation in its output. The reachability
 * report is red at 354 pre-existing violations (ADR 0130 §6 — a selective
 * build may carry every first-party module), so its exit code proves
 * nothing today. What it can still prove is that the detector sees the new
 * edge, which is the property the mutation is testing.
 */
const buildNames = (needle) => ({
  kind: "names",
  needle,
  label: `pages build reachability report names ${needle}`,
  command: "pnpm",
  args: [
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@opensesame/pages",
    "--force",
  ],
  env: { VITE_BASE: "/OpenSesame/" },
});

export const MUTATIONS = [
  {
    id: "permissive-default",
    contract:
      "An optional capability the instance does not permit is never approved (P-AUTHORITY, TRUST).",
    file: `${COMPOSITION}/src/resolve-axes.ts`,
    find: "  const blocked: ReasonCode[] = policyReasons(ctx, d.id);",
    replace:
      "  const blocked: ReasonCode[] = [];\n  void policyReasons(ctx, d.id);",
    gate: suite("@opensesame/capability-composition"),
  },
  {
    id: "scope-widening",
    contract:
      "A vault-session restriction may only narrow; it can never enlarge the approved set (P-SCOPING).",
    file: `${COMPOSITION}/src/resolve-axes.ts`,
    find: '  if (ctx.vaultForeign || ctx.vaultDisabled.has(d.id))\n    blocked.push("DISABLED_IN_VAULT");',
    replace: "  // mutation: the vault scope stops applying at all",
    gate: suite("@opensesame/capability-composition"),
  },
  {
    id: "origin-wide-cache-cleanup",
    contract:
      "Cleanup deletes only caches this application, scope, release and variant own — never another origin's or another release's in use (PWA).",
    file: `${PAGES}/src/sw/cleanup.ts`,
    find: "  const stale = staleCacheNames(names, input);",
    replace: "  const stale = names;",
    gate: suite("@opensesame/pages", "src/sw"),
  },
  {
    id: "stale-lease",
    contract:
      "A module whose lease went stale during its own import is disposed, not activated (LOAD, P-NOLOAD).",
    file: `${PAGES}/src/lib/capabilities/lease.ts`,
    find: '  if (!leaseIsCurrent(lease, currentGeneration)) {\n    throw new CapabilityDenied("STALE_LEASE", subject);\n  }',
    replace:
      "  void leaseIsCurrent(lease, currentGeneration);\n  void subject;",
    gate: suite("@opensesame/pages", "src/lib/capabilities"),
  },
  {
    id: "consent-replay",
    contract:
      "A receipt written for another instance or another installation covers nothing here (CONSENT, P-SCOPING).",
    file: `${COMPOSITION}/src/consent.ts`,
    find:
      "  if (receipt.instanceId !== instanceId) return null;\n" +
      "  if (receipt.installationId !== installationId) return null;",
    replace: "  void instanceId;\n  void installationId;",
    gate: suite("@opensesame/capability-composition"),
  },
  {
    id: "forbidden-import",
    contract:
      "The core entry does not statically reach an optional capability's module (P-NOLOAD).",
    file: `${PAGES}/src/bootstrap/boot.ts`,
    find: 'import { CORE_BOOT_KEYS } from "./core-keys.js";',
    replace:
      'import { CORE_BOOT_KEYS } from "./core-keys.js";\nimport "../modules/telemetry.external/runtime.js";',
    gate: buildNames("src/bootstrap/boot.ts"),
  },
];
