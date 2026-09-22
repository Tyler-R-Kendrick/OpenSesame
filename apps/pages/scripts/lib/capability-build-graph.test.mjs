import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, test } from "vitest";
import { buildGraph } from "../capability-compose-plugin.mjs";
import {
  CLASSIFICATION,
  compose,
  fakeBundle,
  makeFixtureTree,
  policy,
  profileFile,
  selection,
} from "./capability-fixtures.mjs";
import {
  canonicalJson,
  classifyModule,
  parseHtmlEntry,
} from "./capability-graph.mjs";
import { violations } from "./capability-invariants.mjs";

// Module classification and the emitted graph: what `capability-graph.json`
// says about a bundle, and that two identical bundles produce it byte for byte.

const tree = { tmpRoot: null, appRoot: null, inventory: null };
beforeAll(() => Object.assign(tree, makeFixtureTree()));
afterAll(() => rmSync(tree.tmpRoot, { recursive: true, force: true }));

describe("classification", () => {
  const repoRoot = "/repo";
  const classify = (id) => classifyModule(id, CLASSIFICATION, { repoRoot });
  test("longest matching prefix wins, with word boundaries", () => {
    assert.equal(
      classify("/repo/apps/pages/src/lib/push.ts").capability,
      "notifications.web-push",
    );
    assert.equal(
      classify("/repo/apps/pages/src/lib/pushover.ts").classification,
      "core",
    );
    assert.equal(
      classify("/repo/apps/pages/src/lib/kv.ts").rationale,
      "core lib",
    );
  });
  test("virtual and null-byte ids are core", () => {
    assert.deepEqual(
      classifyModule("\0virtual:opensesame-distribution", CLASSIFICATION, {
        repoRoot,
      }),
      {
        id: "virtual:opensesame-distribution",
        classification: "core",
        capability: null,
        rationale: "virtual",
      },
    );
  });
  test("pnpm node_modules paths normalize to node_modules/<pkg>", () => {
    const entry = classify(
      "/repo/node_modules/.pnpm/@vercel+connect@2.2.0/node_modules/@vercel/connect/dist/index.js?commonjs-entry",
    );
    assert.equal(entry.id, "node_modules/@vercel/connect/dist/index.js");
    assert.equal(entry.capability, "connectors.external");
    assert.equal(
      classify("/repo/node_modules/.pnpm/zod@4/node_modules/zod/index.js")
        .rationale,
      "unclassified dependency",
    );
  });
  test("a module directory is owned by its directory name even under a bare src/modules/ rule", () => {
    const rules = [
      ...CLASSIFICATION,
      {
        pattern: "src/modules/",
        classification: "optional",
        capability: "agents.webmcp",
        rationale: "placeholder",
      },
    ];
    const entry = classifyModule(
      "/repo/apps/pages/src/modules/sharing.drops/runtime.ts",
      rules,
      { repoRoot },
    );
    assert.deepEqual(
      [entry.classification, entry.capability, entry.rationale],
      ["optional", "sharing.drops", "module directory"],
    );
  });
});

describe("graph emission", () => {
  const html = `<!doctype html><html><head><link rel="modulepreload" crossorigin href="/OpenSesame/assets/pre-1.js"><script type="module" crossorigin src="/OpenSesame/assets/main-1.js"></script></head></html>`;
  test("parseHtmlEntry resolves base-prefixed, absolute and relative references", () => {
    assert.deepEqual(
      parseHtmlEntry(html, { base: "/OpenSesame/", htmlFile: "index.html" }),
      { scripts: ["assets/main-1.js"], preloads: ["assets/pre-1.js"] },
    );
    assert.deepEqual(
      parseHtmlEntry(`<script type="module" src="../assets/r.js"></script>`, {
        base: "./",
        htmlFile: "auth/redirect.html",
      }).scripts,
      ["assets/r.js"],
    );
    assert.deepEqual(
      parseHtmlEntry(
        `<script src="https://x/live.js"></script><script type="module" src="https://x/m.js"></script>`,
        { base: "/", htmlFile: "index.html" },
      ).scripts,
      [],
    );
  });

  test("BUILD-08: two identical bundles produce byte-identical capability-graph.json with no timestamp", async () => {
    const { main } = await compose(tree, { mode: "selective" });
    const state = main.__state();
    const { ctx, bundle } = fakeBundle(tree.appRoot, html);
    const first = canonicalJson(
      buildGraph(ctx, bundle(), state, "/OpenSesame/"),
    );
    const second = canonicalJson(
      buildGraph(ctx, bundle(), state, "/OpenSesame/"),
    );
    assert.equal(first, second);
    const graph = JSON.parse(first);
    assert.equal(graph.generatedAt, null);
    assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(graph.entries, [
      {
        html: "index.html",
        capability: null,
        scripts: ["assets/main-1.js"],
        preloads: ["assets/pre-1.js"],
      },
    ]);
    assert.deepEqual(
      graph.chunks.map((c) => c.file),
      ["assets/cap-sharing.drops-1.js", "assets/main-1.js", "assets/pre-1.js"],
    );
    assert.deepEqual(
      graph.chunks[1].modules.map((m) => [m.id, m.classification, m.rationale]),
      [
        ["apps/pages/src/main.tsx", "core", "bootstrap"],
        ["virtual:opensesame-capability-modules", "core", "virtual"],
      ],
    );
    assert.deepEqual(graph.chunks[1].importedCss, ["assets/main.css"]);
    assert.deepEqual(graph.moduleEdges, [
      {
        from: "apps/pages/src/main.tsx",
        to: "apps/pages/src/modules/sharing.drops/runtime.ts",
        toCapability: "sharing.drops",
        kind: "dynamic",
        viaTable: false,
      },
      {
        from: "virtual:opensesame-capability-modules",
        to: "apps/pages/src/modules/sharing.drops/runtime.ts",
        toCapability: "sharing.drops",
        kind: "dynamic",
        viaTable: true,
      },
    ]);
    assert.deepEqual(
      graph.workers.map((w) => w.variant),
      ["core-only", "push"],
    );
    const found = violations(graph, state.sets.distributed, "selective", {
      coreCapabilities: state.sets.core,
    });
    assert.deepEqual(
      found.map((v) => v.code),
      ["CORE_DYNAMIC_OPTIONAL"],
    );
  });
});
