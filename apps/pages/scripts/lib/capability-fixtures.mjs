/**
 * Shared fixtures for the capability build tests: a stand-in inventory (a
 * catalog, a classification rule set, module/HTML/public ownership), the
 * policy and selection shapes a profile carries, a throwaway repo tree the
 * plugin can resolve module entries in, and the synthetic graphs the
 * invariant tests reason over. One corpus so each test file stays small
 * (ADR 0093) and they cannot drift apart.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityCompose } from "../capability-compose-plugin.mjs";

export const descriptor = (id, tier, extra = {}) => ({
  id,
  tier,
  dependencies: [],
  alternatives: [],
  moduleIds: [],
  workerGraphConstraint: null,
  ...extra,
});

export const CATALOG = {
  catalogVersion: 1,
  capabilities: [
    descriptor("vault.passwords", "core"),
    descriptor("connectors.external", "optional", {
      moduleIds: ["connectors.external/runtime"],
    }),
    descriptor("notifications.web-push", "optional", {
      moduleIds: [
        "notifications.web-push/runtime",
        "notifications.web-push/worker",
      ],
      workerGraphConstraint: "push",
    }),
    descriptor("sharing.drops", "optional", {
      moduleIds: ["sharing.drops/runtime"],
    }),
    descriptor("sharing.household", "optional", {
      moduleIds: ["sharing.household/runtime"],
      alternatives: [{ slot: "transport", oneOf: ["sharing.drops"] }],
    }),
  ],
};

export const CLASSIFICATION = [
  {
    pattern: "src/main.tsx",
    classification: "core",
    capability: null,
    rationale: "bootstrap",
  },
  {
    pattern: "src/lib/",
    classification: "core",
    capability: null,
    rationale: "core lib",
  },
  {
    pattern: "src/lib/push",
    classification: "optional",
    capability: "notifications.web-push",
    rationale: "push",
  },
  {
    pattern: "src/sections/connections/",
    classification: "optional",
    capability: "connectors.external",
    rationale: "connectors",
  },
  {
    pattern: "node_modules/@vercel/connect",
    classification: "optional",
    capability: "connectors.external",
    rationale: "exclusive vendor",
  },
  {
    pattern: "node_modules/react",
    classification: "shared",
    capability: null,
    rationale: "framework",
  },
];
let inventory;
export const policy = (required, optional, prohibited = []) => ({
  schemaVersion: 1,
  kind: "InstanceCapabilityPolicy",
  instanceId: "inst",
  revision: "r1",
  presetProvenance: null,
  capabilities: { default: "deny", required, optional, prohibited },
  network: { externalServices: "allow", allowedServiceOrigins: [] },
  updates: {
    unknownCapabilities: "deny",
    expandedExposure: "require-approval",
  },
});
export const selection = (
  acceptedRequired,
  selectedOptional,
  chosenAlternatives = {},
) => ({
  schemaVersion: 1,
  kind: "InstallationCapabilitySelection",
  instanceId: "inst",
  installationId: "install",
  basePolicyRevision: "r1",
  revision: "s1",
  acceptedRequired,
  selectedOptional,
  chosenAlternatives,
  delivery: { prefetch: "none", offlineCache: "shell-only" },
});

/**
 * A throwaway `<repo>/apps/pages` tree (so module ids normalize to
 * `apps/pages/src/...`) plus the inventory that describes it. The caller
 * removes `tmpRoot` afterwards.
 */
export function makeFixtureTree() {
  let tmpRoot;
  let appRoot;
  let inventory;
  // Laid out as <repo>/apps/pages so module ids normalize to `apps/pages/src/...`.
  tmpRoot = mkdtempSync(join(tmpdir(), "capability-compose-"));
  appRoot = join(tmpRoot, "apps/pages");
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(
    join(appRoot, "package.json"),
    JSON.stringify({ version: "9.9.9" }),
  );
  for (const id of [
    "connectors.external",
    "notifications.web-push",
    "sharing.drops",
    "sharing.household",
  ]) {
    mkdirSync(join(appRoot, "src/modules", id), { recursive: true });
    writeFileSync(
      join(appRoot, "src/modules", id, "runtime.ts"),
      "export const capabilityRuntime = {};\n",
    );
  }
  mkdirSync(join(appRoot, "auth"), { recursive: true });
  writeFileSync(join(appRoot, "auth/redirect.html"), "<html></html>");
  writeFileSync(join(appRoot, "index.html"), "<html></html>");
  inventory = {
    source: "authored",
    missing: [],
    catalog: CATALOG,
    moduleOwnership: {
      "connectors.external/runtime": {
        entry: "src/modules/connectors.external/runtime.ts",
        capability: "connectors.external",
        environments: ["document"],
      },
      "notifications.web-push/runtime": {
        entry: "src/modules/notifications.web-push/runtime.ts",
        capability: "notifications.web-push",
        environments: ["document"],
      },
      "notifications.web-push/worker": {
        entry: "src/sw-push.ts",
        capability: "notifications.web-push",
        environments: ["service-worker"],
      },
      "sharing.drops/runtime": {
        entry: "src/modules/sharing.drops/runtime.ts",
        capability: "sharing.drops",
        environments: ["document"],
      },
      "sharing.household/runtime": {
        entry: "src/modules/sharing.household/runtime.ts",
        capability: "sharing.household",
        environments: ["document"],
      },
    },
    htmlEntryOwnership: { "auth/redirect.html": "connectors.external" },
    publicFileOwnership: {
      "icon.svg": null,
      "auth.js": "connectors.external",
      "static-auth/**": "connectors.external",
    },
    classification: CLASSIFICATION,
  };
  return { tmpRoot, appRoot, inventory };
}

/** Write a profile JSON into the fixture tree and return its path. */
export function profileFile(tree, name, body) {
  const path = join(tree.appRoot, `${name}.json`);
  writeFileSync(
    path,
    typeof body === "string" ? body : JSON.stringify({ name, ...body }),
  );
  return path;
}

/** Drive the normal plugin's config → configResolved → load hooks by hand. */
export async function compose(tree, options) {
  // `env: {}` keeps vitest's own VITEST variable out of the plugin's view;
  // under the real vitest config resolution the plugin is deliberately inert.
  const [main] = capabilityCompose({
    appRoot: tree.appRoot,
    repoRoot: tree.tmpRoot,
    inventory: tree.inventory,
    logger: { warn() {} },
    env: {},
    ...options,
  });
  const userConfig = {
    base: "/OpenSesame/",
    build: {
      rollupOptions: {
        input: {
          main: join(tree.appRoot, "index.html"),
          msalRedirect: join(tree.appRoot, "auth/redirect.html"),
        },
      },
    },
  };
  await main.config(userConfig, { command: "build", mode: "production" });
  main.configResolved({
    base: "/OpenSesame/",
    command: "build",
    logger: { warn() {} },
  });
  const table = main.load(
    main.resolveId("virtual:opensesame-capability-modules"),
  );
  const distribution = main.load(
    main.resolveId("virtual:opensesame-distribution"),
  );
  return { main, userConfig, table, distribution };
}

// --- synthetic graphs -------------------------------------------------------

export const mod = (id, classification, capability = null) => ({
  id,
  classification,
  capability,
  rationale: "test",
  size: 1,
});
export const chunk = (
  file,
  modules,
  { imports = [], dynamicImports = [], isEntry = false } = {},
) => ({
  file,
  name: file,
  isEntry,
  isDynamicEntry: false,
  imports,
  dynamicImports,
  importedCss: [],
  importedAssets: [],
  modules,
});
export const baseGraph = (chunks, extra = {}) => ({
  entries: [
    {
      html: "index.html",
      capability: null,
      scripts: ["assets/main.js"],
      preloads: [],
    },
  ],
  chunks,
  workers: [],
  publicFiles: [],
  moduleEdges: [],
  ...extra,
});
export const DISTRIBUTED = new Set(["vault.passwords", "sharing.drops"]);
export const CORE = new Set(["vault.passwords"]);
export const errorsOf = (list) =>
  list.filter((v) => v.severity === "error").map((v) => v.code);

