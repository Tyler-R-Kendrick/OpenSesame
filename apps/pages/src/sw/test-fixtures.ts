/**
 * A small `capability-graph.json` the worker tests share: a core entry with a
 * vendor import and a stylesheet, one optional module chunk with its own
 * import and stylesheet, and one optional chunk no plan in these tests
 * approves — the file PWA-05 asserts is never fetched.
 */

import type { JsonObject } from "@opensesame/os-domain";

export const MAIN_JS = "assets/main-abc.js";
export const MAIN_CSS = "assets/main-abc.css";
export const VENDOR_JS = "assets/vendor-111.js";
export const CONNECTORS_JS = "assets/connectors-222.js";
export const CONNECTORS_CSS = "assets/connectors-222.css";
export const SHARED_JS = "assets/shared-333.js";
export const EXCLUDED_JS = "assets/excluded-444.js";

export const CONNECTORS_MODULE = "connectors.external/runtime";
export const EXCLUDED_MODULE = "wallet.spending/runtime";

export const FIXTURE_GRAPH: JsonObject = {
  chunks: [
    {
      file: MAIN_JS,
      isEntry: true,
      imports: [VENDOR_JS],
      css: [MAIN_CSS],
      modules: [{ moduleId: null, capability: null }],
    },
    { file: VENDOR_JS, modules: [{ moduleId: null, capability: null }] },
    {
      file: CONNECTORS_JS,
      imports: [SHARED_JS],
      dynamicImports: [EXCLUDED_JS],
      css: [CONNECTORS_CSS],
      modules: [
        { moduleId: CONNECTORS_MODULE, capability: "connectors.external" },
      ],
    },
    { file: SHARED_JS, modules: [{ moduleId: null, capability: null }] },
    {
      file: EXCLUDED_JS,
      modules: [{ moduleId: EXCLUDED_MODULE, capability: "wallet.spending" }],
    },
  ],
};

/** Every file the fixture graph names, so a test can serve them all. */
export const ALL_FIXTURE_FILES = [
  MAIN_JS,
  MAIN_CSS,
  VENDOR_JS,
  CONNECTORS_JS,
  CONNECTORS_CSS,
  SHARED_JS,
  EXCLUDED_JS,
];

/** What a plan approving only `connectors.external/runtime` needs offline. */
export const CONNECTORS_PLAN_FILES = [
  CONNECTORS_CSS,
  CONNECTORS_JS,
  MAIN_CSS,
  MAIN_JS,
  SHARED_JS,
  VENDOR_JS,
];

export const RELEASE_MANIFEST = [
  { url: "index.html", revision: "r1abc" },
  { url: MAIN_JS, revision: null },
];

export const RELEASE_ID = "r1abc";
export const PLAN_DIGEST = "sha256:0000plan";
