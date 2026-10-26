import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parseCapabilityGraph, resolvePlanAssets } from "../../src/sw/graph.js";
import { parseHtmlEntry } from "./capability-graph.mjs";

test("the actual shell's classic schema bootstrap is in the core offline plan", () => {
  const base = "/OpenSesame/";
  const html = readFileSync(
    new URL("../../index.html", import.meta.url),
    "utf8",
  ).replaceAll("%BASE_URL%", base);
  const entry = parseHtmlEntry(html, { base, htmlFile: "index.html" });
  assert(entry.assets.includes("browser-schema-config.js"));
  assert(!entry.scripts.includes("browser-schema-config.js"));
  const graph = parseCapabilityGraph({
    chunks: [],
    entries: [
      { ...entry, html: "index.html", capability: null },
      {
        html: "auth/optional.html",
        capability: "connectors.external",
        assets: ["optional-bootstrap.js"],
      },
    ],
    publicFiles: [{ file: "unrelated.js", capability: null }],
  });
  assert(graph);
  const plan = resolvePlanAssets(graph, []);
  assert(plan.ok);
  assert(plan.files.includes("browser-schema-config.js"));
  assert(!plan.files.includes("optional-bootstrap.js"));
  assert(!plan.files.includes("unrelated.js"));
});

test("classic shell resources exclude remote scripts and keep module roots separate", () => {
  const entry = parseHtmlEntry(
    '<script src="./boot.js"></script><script src="//other.test/x.js"></script><script src="https://other.test/y.js"></script><script type="module" src="./main.js"></script>',
    { base: "/OpenSesame/", htmlFile: "index.html" },
  );
  assert.deepEqual(entry.assets, ["boot.js"]);
  assert.deepEqual(entry.scripts, ["main.js"]);
});
