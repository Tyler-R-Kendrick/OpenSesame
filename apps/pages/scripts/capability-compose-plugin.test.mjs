import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { buildGraph, capabilityCompose } from "./capability-compose-plugin.mjs";
import {
  canonicalJson,
  classifyModule,
  distributedCapabilities,
  entryClosure,
  formatViolations,
  parseHtmlEntry,
  violations,
} from "./lib/capability-graph.mjs";

// --- fixture inventory (stands in for S02 until its files land) ------------

const descriptor = (id, tier, extra = {}) => ({
  id,
  tier,
  dependencies: [],
  alternatives: [],
  moduleIds: [],
  workerGraphConstraint: null,
  ...extra,
});

const CATALOG = {
  catalogVersion: 1,
  capabilities: [
    descriptor("vault.passwords", "core"),
    descriptor("connectors.external", "optional", { moduleIds: ["connectors.external/runtime"] }),
    descriptor("notifications.web-push", "optional", {
      moduleIds: ["notifications.web-push/runtime", "notifications.web-push/worker"],
      workerGraphConstraint: "push",
    }),
    descriptor("sharing.drops", "optional", { moduleIds: ["sharing.drops/runtime"] }),
    descriptor("sharing.household", "optional", {
      moduleIds: ["sharing.household/runtime"],
      alternatives: [{ slot: "transport", oneOf: ["sharing.drops"] }],
    }),
  ],
};

const CLASSIFICATION = [
  { pattern: "src/main.tsx", classification: "core", capability: null, rationale: "bootstrap" },
  { pattern: "src/lib/", classification: "core", capability: null, rationale: "core lib" },
  { pattern: "src/lib/push", classification: "optional", capability: "notifications.web-push", rationale: "push" },
  { pattern: "src/sections/connections/", classification: "optional", capability: "connectors.external", rationale: "connectors" },
  { pattern: "node_modules/@vercel/connect", classification: "optional", capability: "connectors.external", rationale: "exclusive vendor" },
  { pattern: "node_modules/react", classification: "shared", capability: null, rationale: "framework" },
];

let tmpRoot;
let appRoot;
let inventory;
const policy = (required, optional, prohibited = []) => ({
  schemaVersion: 1,
  kind: "InstanceCapabilityPolicy",
  instanceId: "inst",
  revision: "r1",
  presetProvenance: null,
  capabilities: { default: "deny", required, optional, prohibited },
  network: { externalServices: "allow", allowedServiceOrigins: [] },
  updates: { unknownCapabilities: "deny", expandedExposure: "require-approval" },
});
const selection = (acceptedRequired, selectedOptional, chosenAlternatives = {}) => ({
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

beforeAll(() => {
  // Laid out as <repo>/apps/pages so module ids normalize to `apps/pages/src/...`.
  tmpRoot = mkdtempSync(join(tmpdir(), "capability-compose-"));
  appRoot = join(tmpRoot, "apps/pages");
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, "package.json"), JSON.stringify({ version: "9.9.9" }));
  for (const id of ["connectors.external", "notifications.web-push", "sharing.drops", "sharing.household"]) {
    mkdirSync(join(appRoot, "src/modules", id), { recursive: true });
    writeFileSync(join(appRoot, "src/modules", id, "runtime.ts"), "export const capabilityRuntime = {};\n");
  }
  mkdirSync(join(appRoot, "auth"), { recursive: true });
  writeFileSync(join(appRoot, "auth/redirect.html"), "<html></html>");
  writeFileSync(join(appRoot, "index.html"), "<html></html>");
  inventory = {
    source: "authored",
    missing: [],
    catalog: CATALOG,
    moduleOwnership: {
      "connectors.external/runtime": { entry: "src/modules/connectors.external/runtime.ts", capability: "connectors.external", environments: ["document"] },
      "notifications.web-push/runtime": { entry: "src/modules/notifications.web-push/runtime.ts", capability: "notifications.web-push", environments: ["document"] },
      "notifications.web-push/worker": { entry: "src/sw-push.ts", capability: "notifications.web-push", environments: ["service-worker"] },
      "sharing.drops/runtime": { entry: "src/modules/sharing.drops/runtime.ts", capability: "sharing.drops", environments: ["document"] },
      "sharing.household/runtime": { entry: "src/modules/sharing.household/runtime.ts", capability: "sharing.household", environments: ["document"] },
    },
    htmlEntryOwnership: { "auth/redirect.html": "connectors.external" },
    publicFileOwnership: { "icon.svg": null, "auth.js": "connectors.external", "static-auth/**": "connectors.external" },
    classification: CLASSIFICATION,
  };
});
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function profileFile(name, body) {
  const path = join(appRoot, `${name}.json`);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify({ name, ...body }));
  return path;
}

/** Drive the normal plugin's config → configResolved → load hooks by hand. */
async function compose(options) {
  // `env: {}` keeps vitest's own VITEST variable out of the plugin's view;
  // under the real vitest config resolution the plugin is deliberately inert.
  const [main] = capabilityCompose({ appRoot, repoRoot: tmpRoot, inventory, logger: { warn() {} }, env: {}, ...options });
  const userConfig = {
    base: "/OpenSesame/",
    build: { rollupOptions: { input: { main: join(appRoot, "index.html"), msalRedirect: join(appRoot, "auth/redirect.html") } } },
  };
  await main.config(userConfig, { command: "build", mode: "production" });
  main.configResolved({ base: "/OpenSesame/", command: "build", logger: { warn() {} } });
  const table = main.load(main.resolveId("virtual:opensesame-capability-modules"));
  const distribution = main.load(main.resolveId("virtual:opensesame-distribution"));
  return { main, userConfig, table, distribution };
}

describe("virtual modules", () => {
  test("selective: every owned document module is in the table; both HTML entries stay", async () => {
    const { userConfig, table, distribution } = await compose({ mode: "selective" });
    for (const id of ["connectors.external/runtime", "notifications.web-push/runtime", "sharing.drops/runtime", "sharing.household/runtime"]) {
      assert.match(table, new RegExp(`"${id.replace(".", "\\.")}": \\(\\) => import\\("${appRoot}/src/modules/${id.split("/")[0].replace(".", "\\.")}/runtime\\.ts"\\)`));
    }
    assert.doesNotMatch(table, /worker/, "worker units never enter the page table");
    assert.deepEqual(Object.keys(userConfig.build.rollupOptions.input), ["main", "msalRedirect"]);
    assert.equal(typeof userConfig.build.rollupOptions.output.manualChunks, "function");
    const contract = JSON.parse(distribution.match(/Object\.freeze\((.*)\);\n$/s)[1]);
    assert.equal(contract.mode, "selective");
    assert.deepEqual(contract.workerVariants.map((v) => v.id), ["core-only", "push"]);
    assert.match(contract.distributionId, /^dist:[0-9a-f]{64}$/);
    assert.equal(contract.basePath, "/OpenSesame/");
  });

  test("hardened: only the selected closure (+core) is distributed; excluded HTML entry is dropped", async () => {
    const profilePath = profileFile("household", {
      instancePolicy: policy([], ["sharing.household", "sharing.drops"]),
      installationSelection: selection([], ["sharing.household"], { transport: "sharing.drops" }),
    });
    const { userConfig, table, distribution } = await compose({ mode: "hardened", profilePath });
    assert.match(table, /"sharing\.household\/runtime"/);
    assert.match(table, /"sharing\.drops\/runtime"/, "the chosen alternative rides along");
    assert.doesNotMatch(table, /connectors\.external/);
    assert.doesNotMatch(table, /web-push/);
    assert.deepEqual(Object.keys(userConfig.build.rollupOptions.input), ["main"]);
    const contract = JSON.parse(distribution.match(/Object\.freeze\((.*)\);\n$/s)[1]);
    assert.deepEqual(contract.capabilityIds, ["sharing.drops", "sharing.household", "vault.passwords"]);
    assert.deepEqual(contract.workerVariants.map((v) => v.id), ["core-only"], "push variant only when web-push is distributed");
    const chunkFor = userConfig.build.rollupOptions.output.manualChunks;
    assert.equal(chunkFor(`${appRoot}/src/sections/connections/List.tsx`), "cap-connectors.external");
    assert.equal(chunkFor(`${appRoot}/src/lib/kv.ts`), undefined);
    assert.equal(chunkFor(`${appRoot}/src/sections/connections/a.css`), undefined, "stylesheets keep Vite's own placement");
  });

  test("distributionId is stable across runs and moves with the distributed set", async () => {
    const a = (await compose({ mode: "selective" })).distribution;
    const b = (await compose({ mode: "selective" })).distribution;
    assert.equal(a, b);
    const c = (await compose({ mode: "hardened" })).distribution;
    assert.notEqual(a, c);
  });
});

describe("invalid profiles throw (BUILD-05)", () => {
  const rejects = (options, pattern) => assert.rejects(compose(options), pattern);
  test("parse error", () => rejects({ profilePath: profileFile("broken", "{ not json") }, /not JSON/));
  test("unknown capability", () =>
    rejects({ profilePath: profileFile("unknown", { installationSelection: selection([], ["vault.time-travel"]) }) }, /unknown capability "vault.time-travel"/));
  test("contradictory policy: a capability both required and prohibited", () =>
    rejects(
      { profilePath: profileFile("contra", { instancePolicy: policy(["connectors.external"], [], ["connectors.external"]), installationSelection: selection(["connectors.external"], []) }) },
      /both required and prohibited/,
    ));
  test("contradictory policy: a core capability in a policy set", () =>
    rejects({ profilePath: profileFile("coreset", { instancePolicy: policy([], ["vault.passwords"]), installationSelection: selection([], []) }) }, /core capability "vault.passwords"/));
  test("a selected root the policy prohibits is dropped (runtime PROHIBITED_BY_INSTANCE), not a build error", async () => {
    const profilePath = profileFile("prohibited", { instancePolicy: policy([], ["sharing.drops"], ["connectors.external"]), installationSelection: selection([], ["connectors.external", "sharing.drops"]) });
    const { main } = await compose({ mode: "hardened", profilePath });
    const sets = main.__state().sets;
    assert.deepEqual([...sets.distributed].sort(), ["sharing.drops", "vault.passwords"]);
    assert.match(sets.notes.join("\n"), /selected "connectors.external" is not permitted/);
  });
  test("a required root not yet accepted is still distributed (runtime REQUIRED_NOT_ACCEPTED)", async () => {
    const profilePath = profileFile("unaccepted", { instancePolicy: policy(["connectors.external"], []), installationSelection: selection([], []) });
    const { main } = await compose({ mode: "hardened", profilePath });
    assert.deepEqual([...main.__state().sets.distributed].sort(), ["connectors.external", "vault.passwords"]);
  });
  test("alternative not chosen", () =>
    rejects({ profilePath: profileFile("noalt", { instancePolicy: policy([], ["sharing.household", "sharing.drops"]), installationSelection: selection([], ["sharing.household"]) }) }, /alternatives slot "transport"/));
  test("absent module entry file", async () => {
    rmSync(join(appRoot, "src/modules/sharing.drops/runtime.ts"));
    try {
      await rejects({ mode: "selective" }, /entry file is absent: src\/modules\/sharing\.drops\/runtime\.ts/);
    } finally {
      writeFileSync(join(appRoot, "src/modules/sharing.drops/runtime.ts"), "export const capabilityRuntime = {};\n");
    }
  });
  test("worker variant needed but not defined", async () => {
    const catalog = { capabilities: [...CATALOG.capabilities, descriptor("x.y", "optional", { workerGraphConstraint: "quantum" })] };
    await rejects({ inventory: { ...inventory, catalog } }, /needs worker graph "quantum"/);
  });
  test("bad mode env", () => rejects({ env: { OPENSESAME_BUILD_MODE: "sideways" } }, /OPENSESAME_BUILD_MODE/));
});

describe("classification", () => {
  const repoRoot = "/repo";
  const classify = (id) => classifyModule(id, CLASSIFICATION, { repoRoot });
  test("longest matching prefix wins, with word boundaries", () => {
    assert.equal(classify("/repo/apps/pages/src/lib/push.ts").capability, "notifications.web-push");
    assert.equal(classify("/repo/apps/pages/src/lib/pushover.ts").classification, "core");
    assert.equal(classify("/repo/apps/pages/src/lib/kv.ts").rationale, "core lib");
  });
  test("virtual and null-byte ids are core", () => {
    assert.deepEqual(classifyModule("\0virtual:opensesame-distribution", CLASSIFICATION, { repoRoot }), {
      id: "virtual:opensesame-distribution",
      classification: "core",
      capability: null,
      rationale: "virtual",
    });
  });
  test("pnpm node_modules paths normalize to node_modules/<pkg>", () => {
    const entry = classify("/repo/node_modules/.pnpm/@vercel+connect@2.2.0/node_modules/@vercel/connect/dist/index.js?commonjs-entry");
    assert.equal(entry.id, "node_modules/@vercel/connect/dist/index.js");
    assert.equal(entry.capability, "connectors.external");
    assert.equal(classify("/repo/node_modules/.pnpm/zod@4/node_modules/zod/index.js").rationale, "unclassified dependency");
  });
  test("a module directory is owned by its directory name even under a bare src/modules/ rule", () => {
    const rules = [...CLASSIFICATION, { pattern: "src/modules/", classification: "optional", capability: "agents.webmcp", rationale: "placeholder" }];
    const entry = classifyModule("/repo/apps/pages/src/modules/sharing.drops/runtime.ts", rules, { repoRoot });
    assert.deepEqual([entry.classification, entry.capability, entry.rationale], ["optional", "sharing.drops", "module directory"]);
  });
});

// --- synthetic graphs -------------------------------------------------------

const mod = (id, classification, capability = null) => ({ id, classification, capability, rationale: "test", size: 1 });
const chunk = (file, modules, { imports = [], dynamicImports = [], isEntry = false } = {}) => ({
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
const baseGraph = (chunks, extra = {}) => ({
  entries: [{ html: "index.html", capability: null, scripts: ["assets/main.js"], preloads: [] }],
  chunks,
  workers: [],
  publicFiles: [],
  moduleEdges: [],
  ...extra,
});
const DISTRIBUTED = new Set(["vault.passwords", "sharing.drops"]);
const CORE = new Set(["vault.passwords"]);
const errorsOf = (list) => list.filter((v) => v.severity === "error").map((v) => v.code);

describe("violations", () => {
  test("EVID-01: an entry that statically imports an optional module fails in both modes", () => {
    const graph = baseGraph([
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], { imports: ["assets/cap-connectors.external.js"], isEntry: true }),
      chunk("assets/cap-connectors.external.js", [mod("apps/pages/src/sections/connections/List.tsx", "optional", "connectors.external")]),
    ]);
    for (const mode of ["selective", "hardened"]) {
      const found = violations(graph, new Set([...DISTRIBUTED, "connectors.external"]), mode, { coreCapabilities: CORE });
      assert.deepEqual(errorsOf(found), ["ENTRY_STATIC_OPTIONAL"], mode);
      assert.deepEqual(found[0].path, ["assets/main.js", "assets/cap-connectors.external.js"]);
    }
    assert.match(formatViolations(violations(graph, DISTRIBUTED, "selective")), /ENTRY_STATIC_OPTIONAL.*connectors\.external.*index\.html/);
  });

  test("a dynamic import through MODULE_TABLE is not a violation; one outside it is a warning", () => {
    const graph = baseGraph(
      [
        chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core"), mod("virtual:opensesame-capability-modules", "core")], { dynamicImports: ["assets/cap-sharing.drops.js"], isEntry: true }),
        chunk("assets/cap-sharing.drops.js", [mod("apps/pages/src/modules/sharing.drops/runtime.ts", "optional", "sharing.drops")]),
      ],
      {
        moduleEdges: [
          { from: "virtual:opensesame-capability-modules", to: "apps/pages/src/modules/sharing.drops/runtime.ts", toCapability: "sharing.drops", kind: "dynamic", viaTable: true },
          { from: "apps/pages/src/App.tsx", to: "apps/pages/src/modules/sharing.drops/runtime.ts", toCapability: "sharing.drops", kind: "dynamic", viaTable: false },
        ],
      },
    );
    const found = violations(graph, DISTRIBUTED, "hardened", { coreCapabilities: CORE });
    assert.deepEqual(errorsOf(found), []);
    assert.deepEqual(found.map((v) => [v.severity, v.code, v.module]), [["warning", "CORE_DYNAMIC_OPTIONAL", "apps/pages/src/App.tsx"]]);
  });

  test("EVID-02: an excluded module inside a harmless-named chunk fails hardened even when unreachable", () => {
    const graph = baseGraph([
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], { isEntry: true }),
      chunk("assets/index-abc.js", [mod("apps/pages/src/lib/kv.ts", "core"), mod("apps/pages/src/lib/push.ts", "optional", "notifications.web-push")]),
    ]);
    assert.deepEqual(errorsOf(violations(graph, DISTRIBUTED, "hardened", { coreCapabilities: CORE })), ["EXCLUDED_MODULE_EMITTED"]);
    assert.deepEqual(errorsOf(violations(graph, DISTRIBUTED, "selective", { coreCapabilities: CORE })), [], "selective distributes everything");
    const reachable = baseGraph([
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], { dynamicImports: ["assets/index-abc.js"], isEntry: true }),
      chunk("assets/index-abc.js", [mod("apps/pages/src/lib/push.ts", "optional", "notifications.web-push")]),
    ]);
    assert.deepEqual(errorsOf(violations(reachable, DISTRIBUTED, "hardened", { coreCapabilities: CORE })), ["EXCLUDED_MODULE_EMITTED", "EXCLUDED_REACHABLE"]);
  });

  test("BUILD-06: a module under src/modules/<cap>/ classified as anything else is caught", () => {
    const graph = baseGraph([
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], { isEntry: true }),
      chunk("assets/x.js", [mod("apps/pages/src/modules/sharing.drops/runtime.ts", "core")]),
    ]);
    const found = violations(graph, DISTRIBUTED, "selective", { coreCapabilities: CORE });
    assert.deepEqual(errorsOf(found), ["MISCLASSIFIED_MODULE_PATH"]);
    assert.match(found[0].message, /expected optional\/sharing\.drops/);
  });

  test("a chunk mixing two optional capabilities fails (LOAD-04 partition)", () => {
    const graph = baseGraph([
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], { isEntry: true }),
      chunk("assets/shared.js", [mod("a/x.ts", "optional", "sharing.drops"), mod("b/y.ts", "optional", "connectors.external")]),
    ]);
    assert.deepEqual(errorsOf(violations(graph, DISTRIBUTED, "selective")), ["MIXED_CAPABILITY_CHUNK"]);
  });

  test("hardened: excluded HTML entry, public file and worker variant may not be emitted", () => {
    const graph = baseGraph([chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], { isEntry: true })], {
      entries: [
        { html: "index.html", capability: null, scripts: ["assets/main.js"], preloads: [] },
        { html: "auth/redirect.html", capability: "identity.ambient-sso", scripts: [], preloads: [] },
      ],
      publicFiles: [
        { file: "auth.js", capability: "connectors.external", present: true },
        { file: "static-auth/**", capability: "connectors.external", present: false },
        { file: "icon.svg", capability: null, present: true },
      ],
      workers: [{ variant: "push", file: "sw-push.js", capability: "notifications.web-push", present: true }],
    });
    assert.deepEqual(errorsOf(violations(graph, DISTRIBUTED, "hardened", { coreCapabilities: CORE })), ["EXCLUDED_HTML_ENTRY", "EXCLUDED_PUBLIC_FILE", "EXCLUDED_WORKER"]);
  });

  test("an entry owned by an optional capability may reach its own modules statically", () => {
    const graph = baseGraph([
      chunk("assets/redirect.js", [mod("apps/pages/auth/redirect-bridge.ts", "optional", "identity.ambient-sso")], { isEntry: true }),
    ], { entries: [{ html: "auth/redirect.html", capability: "identity.ambient-sso", scripts: ["assets/redirect.js"], preloads: [] }] });
    assert.deepEqual(errorsOf(violations(graph, new Set(["identity.ambient-sso"]), "hardened")), []);
  });

  test("entryClosure follows preloads and workers; staticOnly skips dynamic edges", () => {
    const graph = baseGraph(
      [
        chunk("assets/main.js", [], { imports: ["assets/a.js"], dynamicImports: ["assets/b.js"] }),
        chunk("assets/a.js", []),
        chunk("assets/b.js", []),
        chunk("assets/pre.js", []),
        chunk("sw.js", [], { imports: ["assets/w.js"] }),
        chunk("assets/w.js", []),
      ],
      {
        entries: [{ html: "index.html", capability: null, scripts: ["assets/main.js"], preloads: ["assets/pre.js"] }],
        workers: [{ variant: "core-only", file: "sw.js", capability: null }],
      },
    );
    assert.deepEqual([...entryClosure(graph, { staticOnly: true }).get("index.html").chunks].sort(), ["assets/a.js", "assets/main.js", "assets/pre.js"]);
    assert.deepEqual([...entryClosure(graph).get("index.html").chunks].sort(), ["assets/a.js", "assets/b.js", "assets/main.js", "assets/pre.js"]);
    assert.deepEqual([...entryClosure(graph).get("worker:core-only").chunks].sort(), ["assets/w.js", "sw.js"]);
  });
});

describe("distributedCapabilities", () => {
  test("personal-local (null policy) permits every optional root; hardened keeps core + closure", () => {
    const sets = distributedCapabilities(CATALOG, { name: "p", instancePolicy: null, installationSelection: selection([], ["connectors.external"]) }, "hardened");
    assert.deepEqual([...sets.distributed].sort(), ["connectors.external", "vault.passwords"]);
    assert.deepEqual([...sets.core], ["vault.passwords"]);
  });
  test("selective always distributes the whole catalog but still validates", () => {
    const sets = distributedCapabilities(CATALOG, { name: "p", instancePolicy: null, installationSelection: null }, "selective");
    assert.equal(sets.distributed.size, CATALOG.capabilities.length);
    assert.throws(() => distributedCapabilities(CATALOG, { name: "p", instancePolicy: policy(["nope"], []), installationSelection: null }, "selective"), /unknown capability "nope"/);
  });
});

describe("graph emission", () => {
  const html = `<!doctype html><html><head><link rel="modulepreload" crossorigin href="/OpenSesame/assets/pre-1.js"><script type="module" crossorigin src="/OpenSesame/assets/main-1.js"></script></head></html>`;
  test("parseHtmlEntry resolves base-prefixed, absolute and relative references", () => {
    assert.deepEqual(parseHtmlEntry(html, { base: "/OpenSesame/", htmlFile: "index.html" }), { scripts: ["assets/main-1.js"], preloads: ["assets/pre-1.js"] });
    assert.deepEqual(parseHtmlEntry(`<script type="module" src="../assets/r.js"></script>`, { base: "./", htmlFile: "auth/redirect.html" }).scripts, ["assets/r.js"]);
    assert.deepEqual(parseHtmlEntry(`<script src="https://x/live.js"></script><script type="module" src="https://x/m.js"></script>`, { base: "/", htmlFile: "index.html" }).scripts, []);
  });

  test("BUILD-08: two identical bundles produce byte-identical capability-graph.json with no timestamp", async () => {
    const { main } = await compose({ mode: "selective" });
    const state = main.__state();
    const ids = {
      main: `${appRoot}/src/main.tsx`,
      table: "\0virtual:opensesame-capability-modules",
      drops: `${appRoot}/src/modules/sharing.drops/runtime.ts`,
      react: `${appRoot}/../../node_modules/.pnpm/react@19/node_modules/react/index.js`,
    };
    const info = {
      [ids.main]: { importedIds: [ids.react], dynamicallyImportedIds: [ids.drops] },
      [ids.table]: { importedIds: [], dynamicallyImportedIds: [ids.drops] },
      [ids.drops]: { importedIds: [], dynamicallyImportedIds: [] },
      [ids.react]: { importedIds: [], dynamicallyImportedIds: [] },
    };
    const ctx = { getModuleIds: () => Object.keys(info), getModuleInfo: (id) => info[id] };
    const bundle = () => ({
      "index.html": { type: "asset", source: html },
      "assets/main-1.js": { type: "chunk", name: "main", isEntry: true, isDynamicEntry: false, imports: ["assets/pre-1.js"], dynamicImports: ["assets/cap-sharing.drops-1.js"], modules: { [ids.main]: { renderedLength: 10 }, [ids.table]: { renderedLength: 2 } }, viteMetadata: { importedCss: new Set(["assets/main.css"]), importedAssets: new Set() } },
      "assets/pre-1.js": { type: "chunk", name: "pre", isEntry: false, isDynamicEntry: false, imports: [], dynamicImports: [], modules: { [ids.react]: { renderedLength: 100 } } },
      "assets/cap-sharing.drops-1.js": { type: "chunk", name: "cap-sharing.drops", isEntry: false, isDynamicEntry: true, imports: [], dynamicImports: [], modules: { [ids.drops]: { renderedLength: 5 } } },
      "assets/main.css": { type: "asset", source: "body{}" },
    });
    const first = canonicalJson(buildGraph(ctx, bundle(), state, "/OpenSesame/"));
    const second = canonicalJson(buildGraph(ctx, bundle(), state, "/OpenSesame/"));
    assert.equal(first, second);
    const graph = JSON.parse(first);
    assert.equal(graph.generatedAt, null);
    assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(graph.entries, [{ html: "index.html", capability: null, scripts: ["assets/main-1.js"], preloads: ["assets/pre-1.js"] }]);
    assert.deepEqual(graph.chunks.map((c) => c.file), ["assets/cap-sharing.drops-1.js", "assets/main-1.js", "assets/pre-1.js"]);
    assert.deepEqual(graph.chunks[1].modules.map((m) => [m.id, m.classification, m.rationale]), [
      ["apps/pages/src/main.tsx", "core", "bootstrap"],
      ["virtual:opensesame-capability-modules", "core", "virtual"],
    ]);
    assert.deepEqual(graph.chunks[1].importedCss, ["assets/main.css"]);
    assert.deepEqual(graph.moduleEdges, [
      { from: "apps/pages/src/main.tsx", to: "apps/pages/src/modules/sharing.drops/runtime.ts", toCapability: "sharing.drops", kind: "dynamic", viaTable: false },
      { from: "virtual:opensesame-capability-modules", to: "apps/pages/src/modules/sharing.drops/runtime.ts", toCapability: "sharing.drops", kind: "dynamic", viaTable: true },
    ]);
    assert.deepEqual(graph.workers.map((w) => w.variant), ["core-only", "push"]);
    const found = violations(graph, state.sets.distributed, "selective", { coreCapabilities: state.sets.core });
    assert.deepEqual(found.map((v) => v.code), ["CORE_DYNAMIC_OPTIONAL"]);
  });
});
