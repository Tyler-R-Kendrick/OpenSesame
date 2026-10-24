import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { build } from "vite";
import { afterEach, beforeEach, test } from "vitest";
import { capabilityCompose } from "./capability-compose-plugin.mjs";
import {
  descriptor,
  makeFixtureTree,
  policy,
  profileFile,
  selection,
} from "./lib/capability-fixtures.mjs";

const capability = "enterprise.directory-provisioning";
let tree;
let model;
let runtime;

beforeEach(() => {
  tree = makeFixtureTree();
  tree.inventory.catalog = {
    ...tree.inventory.catalog,
    capabilities: [
      ...tree.inventory.catalog.capabilities,
      descriptor(capability, "optional"),
    ],
  };
  tree.inventory.classification = [
    ...tree.inventory.classification,
    {
      pattern: "src/lib/org-signin",
      classification: "optional",
      capability,
      rationale: "pure directory settings model",
    },
    {
      pattern: "src/lib/cli-app-integration/",
      classification: "shared",
      capability: null,
      rationale: "shared crypto leaf",
    },
  ];
  model = join(tree.tmpRoot, "packages/app-core/src/lib/org-signin.ts");
  runtime = join(tree.appRoot, `src/modules/${capability}/runtime.ts`);
  for (const file of [model, runtime]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'export const directoryValue = () => "directory";\n');
  }
  writeFileSync(
    join(tree.appRoot, "index.html"),
    '<script type="module" src="/src/main.tsx"></script>',
  );
});

afterEach(() => rmSync(tree.tmpRoot, { recursive: true, force: true }));

function options(selected) {
  return {
    appRoot: tree.appRoot,
    repoRoot: tree.tmpRoot,
    inventory: tree.inventory,
    mode: "hardened",
    gate: "enforce",
    env: {},
    logger: { warn() {} },
    profilePath: profileFile(tree, selected ? "selected" : "excluded", {
      instancePolicy: policy([], [capability]),
      installationSelection: selection([], selected ? [capability] : []),
    }),
  };
}

function specifier(file) {
  return `./${relative(join(tree.appRoot, "src"), file).replaceAll("\\", "/")}`;
}

async function bundle(source, selected = false) {
  writeFileSync(join(tree.appRoot, "src/main.tsx"), source);
  return build({
    configFile: false,
    root: tree.appRoot,
    base: "/",
    publicDir: false,
    logLevel: "silent",
    plugins: capabilityCompose(options(selected)),
    build: {
      outDir: join(tree.tmpRoot, "dist"),
      write: false,
      minify: false,
      rollupOptions: {
        output: { experimentalMinChunkSize: 32000 },
      },
    },
  });
}

test("selected pure model retains its lazy owner in an actual Rollup bundle", async () => {
  const result = await bundle(
    `globalThis.loadDirectory = () => import(${JSON.stringify(specifier(model))});`,
    true,
  );
  const chunk = result.output.find(
    (entry) => entry.type === "chunk" && model in entry.modules,
  );
  assert.ok(chunk);
  assert.equal(chunk.name, "directory-signin-model");
  assert.match(chunk.code, /directoryValue/);
});

test.each(["model", "runtime"])(
  "excluded unused pure %s is tree-shaken instead of forced into an empty chunk",
  async (kind) => {
    const file = kind === "model" ? model : runtime;
    const result = await bundle(
      `import ${JSON.stringify(specifier(file))}; globalThis.fixtureResult = "core";`,
    );
    const chunks = result.output.filter((entry) => entry.type === "chunk");
    assert.ok(chunks.some((chunk) => chunk.code.includes("fixtureResult")));
    assert.ok(chunks.every((chunk) => !(file in chunk.modules)));
    assert.ok(chunks.every((chunk) => !chunk.name.includes("directory")));
  },
);

test.each(["model", "runtime"])(
  "excluded genuinely imported %s still fails the emitted-code invariant",
  async (kind) => {
    const file = kind === "model" ? model : runtime;
    await assert.rejects(
      bundle(
        `import { directoryValue } from ${JSON.stringify(specifier(file))}; globalThis.fixtureResult = directoryValue();`,
      ),
      /EXCLUDED_MODULE_EMITTED/,
    );
  },
);

test("excluded ownership defers to the caller while selected and shared pins retain priority", async () => {
  const seen = [];
  const api = { fixture: true };
  for (const selected of [false, true]) {
    const [plugin] = capabilityCompose(options(selected));
    const config = {
      build: {
        rollupOptions: {
          output: {
            manualChunks: (id, receivedApi) => {
              seen.push([id, receivedApi]);
              return "caller";
            },
          },
        },
      },
    };
    await plugin.config(config, { command: "build", mode: "production" });
    const chunkFor = config.build.rollupOptions.output.manualChunks;
    assert.equal(
      chunkFor(model, api),
      selected ? "directory-signin-model" : "caller",
    );
    assert.equal(
      chunkFor(runtime, api),
      selected ? `cap-${capability}` : "caller",
    );
    assert.equal(
      chunkFor(
        join(
          tree.tmpRoot,
          "packages/app-core/src/lib/cli-app-integration/device-crypto.ts",
        ),
        api,
      ),
      "cli-app-integration-crypto",
    );
  }
  assert.deepEqual(seen, [
    [model, api],
    [runtime, api],
  ]);
});
