import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { test } from "vitest";
import { PACKAGE_RULES } from "../../src/lib/capabilities/classification-packages.js";
import {
  compose,
  descriptor,
  makeFixtureTree,
  policy,
  profileFile,
  selection,
} from "./capability-fixtures.mjs";
import { natsCommonJsSource } from "./capability-lazy-leaves.mjs";

const sdk = fileURLToPath(
  new URL("../../src/modules/sharing.live/carriers/nats.ts", import.meta.url),
);

test("the installed NATS SDK initializes with private wrappers and neutral shared loader glue", async () => {
  const tree = makeFixtureTree();
  try {
    tree.inventory.catalog = {
      ...tree.inventory.catalog,
      capabilities: [
        ...tree.inventory.catalog.capabilities,
        descriptor("sharing.live", "optional"),
      ],
    };
    tree.inventory.classification.push(...PACKAGE_RULES);
    const { userConfig } = await compose(tree, { mode: "selective" });
    const input = join(tree.appRoot, "entry.js");
    writeFileSync(
      input,
      `globalThis.loadNats=()=>import(${JSON.stringify(sdk)});`,
    );
    const result = await build({
      configFile: false,
      root: tree.appRoot,
      publicDir: false,
      logLevel: "silent",
      build: {
        target: "es2022",
        modulePreload: false,
        outDir: join(tree.tmpRoot, "dist"),
        minify: false,
        rollupOptions: {
          input,
          output: {
            ...userConfig.build.rollupOptions.output,
            experimentalMinChunkSize: 32000,
          },
        },
      },
    });
    const chunks = result.output.filter((output) => output.type === "chunk");
    const runtime = chunks.find((chunk) => chunk.name === "commonjs-runtime");
    const nats = chunks.find((chunk) => chunk.name === "live-nats");
    assert(runtime && nats);
    assert(
      Object.keys(runtime.modules).every(
        (id) => !id.includes("/node_modules/"),
      ),
    );
    const wrappers = chunks.flatMap((chunk) =>
      Object.keys(chunk.modules)
        .filter((id) => natsCommonJsSource(id))
        .map((id) => ({ id, name: chunk.name })),
    );
    assert(wrappers.length > 20, "exercise actual SDK CommonJS modules");
    assert(wrappers.every((wrapper) => wrapper.name === "live-nats"));
    const excluded = await compose(tree, {
      mode: "hardened",
      profilePath: profileFile(tree, "no-live", {
        instancePolicy: policy([], ["sharing.live"]),
        installationSelection: selection([], []),
      }),
    });
    const excludedChunk =
      excluded.userConfig.build.rollupOptions.output.manualChunks;
    for (const { id } of wrappers) assert.equal(excludedChunk(id), undefined);
    const entry = chunks.find((chunk) => chunk.isEntry);
    assert(entry);
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(join(tree.tmpRoot, "dist", entry.fileName)).href)}); const sdk=await globalThis.loadNats(); if(typeof sdk.natsCarrier!=='function') throw new Error('missing carrier');`,
    ]);
  } finally {
    rmSync(tree.tmpRoot, { recursive: true, force: true });
  }
});

test("only NATS package-private CommonJS wrappers inherit source ownership", () => {
  const source = "/repo/node_modules/@nats-io/nkeys/lib/mod.js";
  assert.equal(natsCommonJsSource(`\0${source}?commonjs-exports`), source);
  assert.equal(natsCommonJsSource(`\0${source}?commonjs-es-import`), source);
  assert.equal(natsCommonJsSource(`${source}?commonjs-exports`), null);
  assert.equal(natsCommonJsSource("\0commonjsHelpers.js"), null);
  assert.equal(
    natsCommonJsSource("\0/repo/node_modules/other/index.js?commonjs-module"),
    null,
  );
});
