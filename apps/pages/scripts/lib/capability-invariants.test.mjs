import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CORE,
  DISTRIBUTED,
  baseGraph,
  chunk,
  errorsOf,
  mod,
} from "./capability-fixtures.mjs";
import { entryClosure } from "./capability-graph.mjs";
import { formatViolations, violations } from "./capability-invariants.mjs";

// The forbidden-reachability rules over synthetic graphs (EVID-01/02,
// BUILD-06, LOAD-04).

describe("violations", () => {
  test("EVID-01: an entry that statically imports an optional module fails in both modes", () => {
    const graph = baseGraph([
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], {
        imports: ["assets/cap-connectors.external.js"],
        isEntry: true,
      }),
      chunk("assets/cap-connectors.external.js", [
        mod(
          "apps/pages/src/sections/connections/List.tsx",
          "optional",
          "connectors.external",
        ),
      ]),
    ]);
    for (const mode of ["selective", "hardened"]) {
      const found = violations(
        graph,
        new Set([...DISTRIBUTED, "connectors.external"]),
        mode,
        { coreCapabilities: CORE },
      );
      assert.deepEqual(errorsOf(found), ["ENTRY_STATIC_OPTIONAL"], mode);
      assert.deepEqual(found[0].path, [
        "assets/main.js",
        "assets/cap-connectors.external.js",
      ]);
    }
    assert.match(
      formatViolations(violations(graph, DISTRIBUTED, "selective")),
      /ENTRY_STATIC_OPTIONAL.*connectors\.external.*index\.html/,
    );
  });

  test("a dynamic import through MODULE_TABLE is not a violation; one outside it is a warning", () => {
    const graph = baseGraph(
      [
        chunk(
          "assets/main.js",
          [
            mod("apps/pages/src/main.tsx", "core"),
            mod("virtual:opensesame-capability-modules", "core"),
          ],
          { dynamicImports: ["assets/cap-sharing.drops.js"], isEntry: true },
        ),
        chunk("assets/cap-sharing.drops.js", [
          mod(
            "apps/pages/src/modules/sharing.drops/runtime.ts",
            "optional",
            "sharing.drops",
          ),
        ]),
      ],
      {
        moduleEdges: [
          {
            from: "virtual:opensesame-capability-modules",
            to: "apps/pages/src/modules/sharing.drops/runtime.ts",
            toCapability: "sharing.drops",
            kind: "dynamic",
            viaTable: true,
          },
          {
            from: "apps/pages/src/App.tsx",
            to: "apps/pages/src/modules/sharing.drops/runtime.ts",
            toCapability: "sharing.drops",
            kind: "dynamic",
            viaTable: false,
          },
        ],
      },
    );
    const found = violations(graph, DISTRIBUTED, "hardened", {
      coreCapabilities: CORE,
    });
    assert.deepEqual(errorsOf(found), []);
    assert.deepEqual(
      found.map((v) => [v.severity, v.code, v.module]),
      [["warning", "CORE_DYNAMIC_OPTIONAL", "apps/pages/src/App.tsx"]],
    );
  });

  test("EVID-02: an excluded module inside a harmless-named chunk fails hardened even when unreachable", () => {
    const graph = baseGraph([
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], {
        isEntry: true,
      }),
      chunk("assets/index-abc.js", [
        mod("apps/pages/src/lib/kv.ts", "core"),
        mod("apps/pages/src/lib/push.ts", "optional", "notifications.web-push"),
      ]),
    ]);
    assert.deepEqual(
      errorsOf(
        violations(graph, DISTRIBUTED, "hardened", { coreCapabilities: CORE }),
      ),
      ["EXCLUDED_MODULE_EMITTED"],
    );
    assert.deepEqual(
      errorsOf(
        violations(graph, DISTRIBUTED, "selective", { coreCapabilities: CORE }),
      ),
      [],
      "selective distributes everything",
    );
    const reachable = baseGraph([
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], {
        dynamicImports: ["assets/index-abc.js"],
        isEntry: true,
      }),
      chunk("assets/index-abc.js", [
        mod("apps/pages/src/lib/push.ts", "optional", "notifications.web-push"),
      ]),
    ]);
    assert.deepEqual(
      errorsOf(
        violations(reachable, DISTRIBUTED, "hardened", {
          coreCapabilities: CORE,
        }),
      ),
      ["EXCLUDED_MODULE_EMITTED", "EXCLUDED_REACHABLE"],
    );
  });
});

describe("violations: chunk partition and module ownership", () => {
  test("BUILD-06: a module under src/modules/<cap>/ classified as anything else is caught", () => {
    const graph = baseGraph([
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], {
        isEntry: true,
      }),
      chunk("assets/x.js", [
        mod("apps/pages/src/modules/sharing.drops/runtime.ts", "core"),
      ]),
    ]);
    const found = violations(graph, DISTRIBUTED, "selective", {
      coreCapabilities: CORE,
    });
    assert.deepEqual(errorsOf(found), ["MISCLASSIFIED_MODULE_PATH"]);
    assert.match(found[0].message, /expected optional\/sharing\.drops/);
  });

  test("a chunk mixing two optional capabilities fails (LOAD-04 partition)", () => {
    const graph = baseGraph([
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], {
        isEntry: true,
      }),
      chunk("assets/shared.js", [
        mod("a/x.ts", "optional", "sharing.drops"),
        mod("b/y.ts", "optional", "connectors.external"),
      ]),
    ]);
    assert.deepEqual(errorsOf(violations(graph, DISTRIBUTED, "selective")), [
      "MIXED_CAPABILITY_CHUNK",
    ]);
  });

  test("hardened: excluded HTML entry, public file and worker variant may not be emitted", () => {
    const graph = baseGraph(
      [
        chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], {
          isEntry: true,
        }),
      ],
      {
        entries: [
          {
            html: "index.html",
            capability: null,
            scripts: ["assets/main.js"],
            preloads: [],
          },
          {
            html: "auth/redirect.html",
            capability: "identity.ambient-sso",
            scripts: [],
            preloads: [],
          },
        ],
        publicFiles: [
          { file: "auth.js", capability: "connectors.external", present: true },
          {
            file: "static-auth/**",
            capability: "connectors.external",
            present: false,
          },
          { file: "icon.svg", capability: null, present: true },
        ],
        workers: [
          {
            variant: "push",
            file: "sw-push.js",
            capability: "notifications.web-push",
            present: true,
          },
        ],
      },
    );
    assert.deepEqual(
      errorsOf(
        violations(graph, DISTRIBUTED, "hardened", { coreCapabilities: CORE }),
      ),
      ["EXCLUDED_HTML_ENTRY", "EXCLUDED_PUBLIC_FILE", "EXCLUDED_WORKER"],
    );
  });
});

describe("violations: entries that own their capability", () => {
  test("an entry owned by an optional capability may reach its own modules statically", () => {
    const graph = baseGraph(
      [
        chunk(
          "assets/redirect.js",
          [
            mod(
              "apps/pages/auth/redirect-bridge.ts",
              "optional",
              "identity.ambient-sso",
            ),
          ],
          { isEntry: true },
        ),
      ],
      {
        entries: [
          {
            html: "auth/redirect.html",
            capability: "identity.ambient-sso",
            scripts: ["assets/redirect.js"],
            preloads: [],
          },
        ],
      },
    );
    assert.deepEqual(
      errorsOf(
        violations(graph, new Set(["identity.ambient-sso"]), "hardened"),
      ),
      [],
    );
  });

  test("entryClosure follows preloads and workers; staticOnly skips dynamic edges", () => {
    const graph = baseGraph(
      [
        chunk("assets/main.js", [], {
          imports: ["assets/a.js"],
          dynamicImports: ["assets/b.js"],
        }),
        chunk("assets/a.js", []),
        chunk("assets/b.js", []),
        chunk("assets/pre.js", []),
        chunk("sw.js", [], { imports: ["assets/w.js"] }),
        chunk("assets/w.js", []),
      ],
      {
        entries: [
          {
            html: "index.html",
            capability: null,
            scripts: ["assets/main.js"],
            preloads: ["assets/pre.js"],
          },
        ],
        workers: [{ variant: "core-only", file: "sw.js", capability: null }],
      },
    );
    assert.deepEqual(
      [
        ...entryClosure(graph, { staticOnly: true }).get("index.html").chunks,
      ].sort(),
      ["assets/a.js", "assets/main.js", "assets/pre.js"],
    );
    assert.deepEqual([...entryClosure(graph).get("index.html").chunks].sort(), [
      "assets/a.js",
      "assets/b.js",
      "assets/main.js",
      "assets/pre.js",
    ]);
    assert.deepEqual(
      [...entryClosure(graph).get("worker:core-only").chunks].sort(),
      ["assets/w.js", "sw.js"],
    );
  });
});
