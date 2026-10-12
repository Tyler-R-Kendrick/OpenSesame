import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { capabilityCompose } from "./capability-compose-plugin.mjs";
import {
  CATALOG,
  compose,
  descriptor,
  makeFixtureTree,
  policy,
  profileFile,
  selection,
} from "./lib/capability-fixtures.mjs";
import { lazyLeafChunk } from "./lib/capability-lazy-leaves.mjs";

// The plugin's own surface: the virtual modules it serves, the HTML entries a
// hardened build drops, and every way a profile is refused (BUILD-05). The
// fixtures live in `lib/capability-fixtures.mjs`; the reachability rules are
// exercised in `lib/capability-invariants.test.mjs`.

const tree = { tmpRoot: null, appRoot: null, inventory: null };
beforeAll(() => Object.assign(tree, makeFixtureTree()));
afterAll(() => rmSync(tree.tmpRoot, { recursive: true, force: true }));

describe("virtual modules", () => {
  test("selective: every owned document module is in the table; both HTML entries stay", async () => {
    const { userConfig, table, distribution } = await compose(tree, {
      mode: "selective",
    });
    for (const id of [
      "connectors.external/runtime",
      "notifications.web-push/runtime",
      "sharing.drops/runtime",
      "sharing.household/runtime",
    ]) {
      assert.match(
        table,
        new RegExp(
          `"${id.replace(".", "\\.")}": \\(\\) => import\\("${tree.appRoot}/src/modules/${id.split("/")[0].replace(".", "\\.")}/runtime\\.ts"\\)`,
        ),
      );
    }
    assert.doesNotMatch(
      table,
      /worker/,
      "worker units never enter the page table",
    );
    assert.deepEqual(Object.keys(userConfig.build.rollupOptions.input), [
      "main",
      "msalRedirect",
    ]);
    assert.equal(
      typeof userConfig.build.rollupOptions.output.manualChunks,
      "function",
    );
    const contract = JSON.parse(
      distribution.match(/Object\.freeze\((.*)\);\n$/s)[1],
    );
    assert.equal(contract.mode, "selective");
    assert.deepEqual(
      contract.workerVariants.map((v) => v.id),
      ["core-only", "push"],
    );
    assert.match(contract.distributionId, /^dist:[0-9a-f]{64}$/);
    assert.equal(contract.basePath, "/OpenSesame/");
  });

  test("hardened: only the selected closure (+core) is distributed; excluded HTML entry is dropped", async () => {
    const profilePath = profileFile(tree, "household", {
      instancePolicy: policy([], ["sharing.household", "sharing.drops"]),
      installationSelection: selection([], ["sharing.household"], {
        transport: "sharing.drops",
      }),
    });
    const { userConfig, table, distribution } = await compose(tree, {
      mode: "hardened",
      profilePath,
    });
    assert.match(table, /"sharing\.household\/runtime"/);
    assert.match(
      table,
      /"sharing\.drops\/runtime"/,
      "the chosen alternative rides along",
    );
    assert.doesNotMatch(table, /connectors\.external/);
    assert.doesNotMatch(table, /web-push/);
    assert.deepEqual(Object.keys(userConfig.build.rollupOptions.input), [
      "main",
    ]);
    const contract = JSON.parse(
      distribution.match(/Object\.freeze\((.*)\);\n$/s)[1],
    );
    assert.deepEqual(contract.capabilityIds, [
      "sharing.drops",
      "sharing.household",
      "vault.passwords",
    ]);
    assert.deepEqual(
      contract.workerVariants.map((v) => v.id),
      ["core-only"],
      "push variant only when web-push is distributed",
    );
  });

  test("distributionId is stable across runs and moves with the distributed set", async () => {
    const a = (await compose(tree, { mode: "selective" })).distribution;
    const b = (await compose(tree, { mode: "selective" })).distribution;
    assert.equal(a, b);
    const c = (await compose(tree, { mode: "hardened" })).distribution;
    assert.notEqual(a, c);
  });
});

// Chunk layout, not exclusion: what a hardened build drops is decided by
// the profile before bundling and proved by the reachability gate.
describe("chunk partition", () => {
  test("only a capability's own module directory is partitioned into its chunk", async () => {
    const { userConfig } = await compose(tree, { mode: "selective" });
    const chunkFor = userConfig.build.rollupOptions.output.manualChunks;
    assert.equal(
      chunkFor(`${tree.appRoot}/src/modules/sharing.drops/runtime.ts`),
      "cap-sharing.drops",
      "a capability's module directory is its own chunk",
    );
    // Optional source outside the module directories keeps Rollup's own
    // chunking. Partitioning it by capability cut cycles across chunk
    // boundaries — a section reaches a shared list which reaches another
    // section — and the emitted chunks then imported each other: React
    // Router's `createContext` ran in one chunk before the chunk holding
    // React had, and the production page threw on load and rendered
    // nothing. What a hardened build drops is decided by the profile
    // before bundling, not by this layout.
    assert.equal(
      chunkFor(`${tree.appRoot}/src/sections/connections/List.tsx`),
      undefined,
    );
    assert.equal(chunkFor(`${tree.appRoot}/src/lib/kv.ts`), undefined);
    assert.equal(
      chunkFor(`${tree.appRoot}/src/modules/sharing.drops/a.css`),
      undefined,
      "stylesheets keep Vite's own placement",
    );
  });

  test("tailnet pairing stays an explicit optional leaf when small chunks merge", () => {
    const source =
      "/repo/packages/app-core/src/lib/tailnet-sync/plugin-pairing.ts";
    const entry = {
      classification: "optional",
      capability: "networking.tailnet",
    };
    assert.equal(lazyLeafChunk(source, entry), "tailnet-plugin-pairing");
    assert.equal(
      lazyLeafChunk(source.replaceAll("/", "\\"), entry),
      "tailnet-plugin-pairing",
    );
    assert.equal(
      lazyLeafChunk(source.replace("plugin-pairing", "plugin-daemon"), entry),
      undefined,
      "the daemon keeps its runtime's ordinary chunk placement",
    );
    assert.equal(
      lazyLeafChunk(source, { classification: "shared", capability: null }),
      undefined,
      "the chunk pin does not reclassify shared code",
    );
    assert.equal(
      lazyLeafChunk(source, {
        classification: "optional",
        capability: "networking.tailnet-devices",
      }),
      undefined,
      "the pin is specific to its existing capability owner",
    );
  });

  test("web-push enrolment joins the capability chunk, not a pure leaf", () => {
    const entry = {
      classification: "optional",
      capability: "notifications.web-push",
    };
    for (const file of [
      "push-browser.ts",
      "push-enrolment.ts",
      "push-seams.ts",
    ]) {
      assert.equal(
        lazyLeafChunk(`${tree.appRoot}/src/lib/${file}`, entry),
        "cap-notifications.web-push",
        file,
      );
    }
    assert.equal(
      lazyLeafChunk(`${tree.appRoot}/src/lib/push.ts`, entry),
      undefined,
      "the worker payload renderer stays out of the document chunk",
    );
  });
});

// Rollup's `input` and `manualChunks` each take more than one form; the
// plugin edits only the forms it can edit and leaves the others as given.
describe("rollup option forms", () => {
  const household = () =>
    profileFile(tree, "household", {
      instancePolicy: policy([], ["sharing.household", "sharing.drops"]),
      installationSelection: selection([], ["sharing.household"], {
        transport: "sharing.drops",
      }),
    });
  const configure = async (rollupOptions) => {
    const [main] = capabilityCompose({
      appRoot: tree.appRoot,
      repoRoot: tree.tmpRoot,
      inventory: tree.inventory,
      logger: { warn() {} },
      env: {},
      mode: "hardened",
      profilePath: household(),
    });
    const userConfig = { base: "/OpenSesame/", build: { rollupOptions } };
    await main.config(userConfig, { command: "build", mode: "production" });
    return userConfig.build.rollupOptions;
  };
  const excluded = () => join(tree.appRoot, "auth/redirect.html");
  const moduleFile = () =>
    `${tree.appRoot}/src/modules/sharing.drops/runtime.ts`;

  test("a path or a list of paths names no entry, so none is dropped", async () => {
    assert.equal((await configure({ input: excluded() })).input, excluded());
    assert.deepEqual((await configure({ input: [excluded()] })).input, [
      excluded(),
    ]);
  });

  test("a chunk function is consulted after the partition", async () => {
    const { output } = await configure({
      output: { manualChunks: () => "vendor" },
    });
    assert.equal(output.manualChunks(moduleFile()), "cap-sharing.drops");
    assert.equal(output.manualChunks(`${tree.appRoot}/src/a.ts`), "vendor");
  });

  test("a chunk record is superseded by the partition", async () => {
    const { output } = await configure({
      output: { manualChunks: { vendor: ["react"] } },
    });
    assert.equal(output.manualChunks(moduleFile()), "cap-sharing.drops");
    assert.equal(output.manualChunks(`${tree.appRoot}/src/a.ts`), undefined);
  });
});

describe("invalid profiles throw (BUILD-05)", () => {
  const rejects = (options, pattern) =>
    assert.rejects(compose(tree, options), pattern);
  test("parse error", () =>
    rejects(
      { profilePath: profileFile(tree, "broken", "{ not json") },
      /not JSON/,
    ));
  test("unknown capability", () =>
    rejects(
      {
        profilePath: profileFile(tree, "unknown", {
          installationSelection: selection([], ["vault.time-travel"]),
        }),
      },
      /unknown capability "vault.time-travel"/,
    ));
  test("contradictory policy: a capability both required and prohibited", () =>
    rejects(
      {
        profilePath: profileFile(tree, "contra", {
          instancePolicy: policy(
            ["connectors.external"],
            [],
            ["connectors.external"],
          ),
          installationSelection: selection(["connectors.external"], []),
        }),
      },
      /both required and prohibited/,
    ));
  test("contradictory policy: a core capability in a policy set", () =>
    rejects(
      {
        profilePath: profileFile(tree, "coreset", {
          instancePolicy: policy([], ["vault.passwords"]),
          installationSelection: selection([], []),
        }),
      },
      /core capability "vault.passwords"/,
    ));
  test("a selected root the policy prohibits is dropped (runtime PROHIBITED_BY_INSTANCE), not a build error", async () => {
    const profilePath = profileFile(tree, "prohibited", {
      instancePolicy: policy([], ["sharing.drops"], ["connectors.external"]),
      installationSelection: selection(
        [],
        ["connectors.external", "sharing.drops"],
      ),
    });
    const { main } = await compose(tree, { mode: "hardened", profilePath });
    const sets = main.__state().sets;
    assert.deepEqual([...sets.distributed].sort(), [
      "sharing.drops",
      "vault.passwords",
    ]);
    assert.match(
      sets.notes.join("\n"),
      /selected "connectors.external" is not permitted/,
    );
  });
  test("a required root not yet accepted is still distributed (runtime REQUIRED_NOT_ACCEPTED)", async () => {
    const profilePath = profileFile(tree, "unaccepted", {
      instancePolicy: policy(["connectors.external"], []),
      installationSelection: selection([], []),
    });
    const { main } = await compose(tree, { mode: "hardened", profilePath });
    assert.deepEqual([...main.__state().sets.distributed].sort(), [
      "connectors.external",
      "vault.passwords",
    ]);
  });
  test("alternative not chosen", () =>
    rejects(
      {
        profilePath: profileFile(tree, "noalt", {
          instancePolicy: policy([], ["sharing.household", "sharing.drops"]),
          installationSelection: selection([], ["sharing.household"]),
        }),
      },
      /alternatives slot "transport"/,
    ));
});

describe("invalid inventories throw (BUILD-05)", () => {
  const rejects = (options, pattern) =>
    assert.rejects(() => compose(tree, options), pattern);
  test("absent module entry file", async () => {
    rmSync(join(tree.appRoot, "src/modules/sharing.drops/runtime.ts"));
    try {
      await rejects(
        { mode: "selective" },
        /entry file is absent: src\/modules\/sharing\.drops\/runtime\.ts/,
      );
    } finally {
      writeFileSync(
        join(tree.appRoot, "src/modules/sharing.drops/runtime.ts"),
        "export const capabilityRuntime = {};\n",
      );
    }
  });
  test("worker variant needed but not defined", async () => {
    const catalog = {
      capabilities: [
        ...CATALOG.capabilities,
        descriptor("x.y", "optional", { workerGraphConstraint: "quantum" }),
      ],
    };
    await rejects(
      { inventory: { ...tree.inventory, catalog } },
      /needs worker graph "quantum"/,
    );
  });
  test("bad mode env", () =>
    rejects(
      { env: { OPENSESAME_BUILD_MODE: "sideways" } },
      /OPENSESAME_BUILD_MODE/,
    ));
});
