import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere, selectGates } from "./ci-changed-areas.mjs";
import {
  ALL_GATES,
  DRIVER_GATES,
  bundleMatrix,
  driverReach,
  gateOfShard,
  gatesForPath,
  gatesForPaths,
  loadShards,
} from "./ci-gates.mjs";

const root = repoRootFromHere();
const reach = driverReach(root);
const gatesOf = (...paths) => [...gatesForPaths(paths, reach)].sort();

describe("ci gates", () => {
  it("names a gate row for every verify script, so a new one is classified on purpose", () => {
    const dir = join(root, "apps/pages/scripts");
    const scripts = readdirSync(dir).filter((name) =>
      /^verify-.*(?<!\.test)\.mjs$/.test(name),
    );
    for (const name of scripts) {
      expect(name in DRIVER_GATES, `${name} has no DRIVER_GATES row`).toBe(
        true,
      );
    }
  });

  it("gives every shard a gate the selector knows", () => {
    for (const { shard } of loadShards(root)) {
      expect(ALL_GATES).toContain(gateOfShard(shard));
    }
  });

  it("selects nothing for prose, tests and deleted paths", () => {
    expect(gatesOf("docs/adr/0001-x.md", "README.md")).toEqual([]);
    expect(gatesOf("apps/pages/src/lib/foo.test.ts")).toEqual([]);
    expect(gatesOf()).toEqual([]);
  });

  it("runs every gate for a path it cannot place", () => {
    expect(gatesOf("apps/pages/vite.config.ts")).toEqual([...ALL_GATES].sort());
    expect(gatesOf("packages/never-heard-of/src/x.ts")).toEqual(
      [...ALL_GATES].sort(),
    );
  });

  it("keeps a settings panel to the gates that can see it", () => {
    const gates = gatesOf("apps/pages/src/sections/settings/security/Row.tsx");
    expect(gates).toContain("auth");
    expect(gates).not.toContain("tutorials");
    expect(gates).not.toContain("push");
  });

  it("sends a stylesheet to the budget and phone gates, not the key gates", () => {
    const gates = gatesOf("apps/pages/src/styles/shell.css");
    expect(gates).toContain("mobile");
    expect(gates).toContain("budgets");
    expect(gates).not.toContain("auth");
  });

  it("runs every gate for an edit to the workflow, which defines them all", () => {
    expect(gatesForPath(".github/workflows/ci.yml", reach)).toEqual(
      new Set(ALL_GATES),
    );
  });

  it("maps the split shards to their one gate", () => {
    expect(gateOfShard("journeys-2")).toBe("journeys");
    expect(gateOfShard("mobile-390")).toBe("mobile");
    expect(gateOfShard("journeys")).toBe("journeys");
    expect(
      bundleMatrix(["journeys"], loadShards(root)).map((leg) => leg.shard),
    ).toEqual(["journeys-1", "journeys-2"]);
  });

  it("writes matrix legs in the shard file's order and only for wanted gates", () => {
    const shards = loadShards(root);
    const legs = bundleMatrix(["mobile", "budgets"], shards).map(
      (leg) => leg.shard,
    );
    expect(legs).toEqual([
      "budgets",
      ...shards.map((s) => s.shard).filter((s) => s.startsWith("mobile-")),
    ]);
    expect(bundleMatrix([], shards)).toEqual([]);
  });
});

describe("ci gates, tutorials", () => {
  const read = (text) => () => text;

  it("starts the tutorial walk for a file that mounts a guide target", () => {
    const path = "apps/pages/src/sections/vault/ItemTools.tsx";
    const mounts = [
      ...gatesForPath(
        path,
        reach,
        read('import { useGuideTarget } from "../../tutorial/registry/react";'),
      ),
    ];
    expect(mounts).toContain("tutorials");
    expect([
      ...gatesForPath(path, reach, read("export const x = 1;")),
    ]).not.toContain("tutorials");
  });

  it("starts it for the keymap, whose keys the keyboard tutorials teach", () => {
    expect(gatesOf("apps/pages/src/lib/keymap.ts")).toContain("tutorials");
    expect(gatesOf("packages/app-core/src/lib/keymap/commands.ts")).toContain(
      "tutorials",
    );
  });

  it("does not start it for the selectors the keymap reads while typing", () => {
    const gates = gatesOf("apps/pages/src/lib/keymap-targets.ts");
    expect(gates).toEqual(["budgets", "journeys", "keyboard"]);
  });

  it("starts it for a settings view-model a tour points through", () => {
    expect(
      gatesOf("packages/app-core/src/sections/settings/x-model.ts"),
    ).toContain("tutorials");
  });

  it("leaves it out for a stylesheet-only or doc-only diff", () => {
    expect(gatesOf("apps/pages/src/styles/shell.css")).not.toContain(
      "tutorials",
    );
  });
});

describe("ci gate selection", () => {
  it("selects the gates for real paths without falling back", async () => {
    const { bundlePackageDirs, pushPackageDirs, selectGates } = await import(
      "./ci-changed-areas.mjs"
    );
    const gates = selectGates(
      root,
      ["apps/pages/src/sections/identity/EditApplication.tsx"],
      bundlePackageDirs(root),
      pushPackageDirs(root),
    );
    expect([...gates].sort()).toEqual(["budgets", "journeys", "sign-in"]);
  });
});

describe("required retired credential and relay gate reachability", () => {
  it.each([
    ["apps/pages/scripts/verify-retired-credentials.mjs", ["auth"]],
    ["apps/pages/scripts/lib/retired-offline-harness.mjs", ["auth"]],
    ["apps/pages/scripts/verify-duress-browser.mjs", ["duress"]],
    ["apps/pages/scripts/duress/journeys/ui-and-scenarios.mjs", ["duress"]],
    ["apps/pages/scripts/verify-live-join.mjs", ["live-transports"]],
    ["scripts/test/live-turn/main.go", ["keyboard", "live-transports"]],
    ["apps/browser-extension/lib/background/service-security.ts", ["auth"]],
    ["apps/browser-extension-autofill/lib/fill/service-security.ts", ["auth"]],
  ])("runs the required gate for %s", (path, expected) => {
    expect(gatesOf(path)).toEqual([...expected].sort());
  });

  it("runs synthetic isolation journeys for security panels and shared controls", () => {
    for (const path of [
      "apps/pages/src/sections/settings/security/DecoyPanel.tsx",
      "apps/pages/src/components/DecoyNavigationAnchor.tsx",
    ]) {
      expect(gatesOf(path)).toEqual(expect.arrayContaining(["auth", "duress"]));
    }
  });

  it("selects actual matrix legs for extension and protocol source changes", () => {
    for (const [path, wanted] of [
      ["apps/browser-extension/lib/background/service-security.ts", ["auth"]],
      [
        "apps/browser-extension-autofill/lib/fill/service-security.ts",
        ["auth"],
      ],
      ["scripts/test/live-turn/main.go", ["keyboard", "live-transports"]],
    ]) {
      const selected = selectGates(root, [path], [], []);
      expect(
        bundleMatrix(selected, loadShards(root)).map((leg) => leg.shard),
      ).toEqual(wanted);
    }
  });
});

describe("browser gate registry changes", () => {
  it("runs all gates when the extracted driver registry changes", () => {
    const selected = selectGates(
      root,
      ["scripts/lib/ci-gate-drivers.mjs"],
      [],
      [],
    );
    expect([...selected].sort()).toEqual([...ALL_GATES].sort());
    expect(bundleMatrix(selected, loadShards(root))).toEqual(loadShards(root));
  });
});
