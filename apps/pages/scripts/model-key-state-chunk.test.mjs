import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { it } from "vitest";
import { lazyLeafChunk } from "./lib/capability-lazy-leaves.mjs";

const policy = fileURLToPath(
  new URL(
    "../../../packages/app-core/src/lib/model-keys/types.ts",
    import.meta.url,
  ),
);
const state = fileURLToPath(
  new URL(
    "../../../packages/app-core/src/lib/model-keys/active.ts",
    import.meta.url,
  ),
);
const classification = {
  classification: "optional",
  capability: "connectors.external",
};

function fixturePlugin() {
  const sources = {
    entry:
      'import {read} from "session"; export const broker=read(); export const policy=(await import("runtime")).PAGE_POLICY;',
    session: `import {activeModelKeyBroker} from ${JSON.stringify(state)}; export const read=()=>activeModelKeyBroker(); export {DEFAULT_POLICY} from ${JSON.stringify(policy)};`,
    runtime: `import {DEFAULT_POLICY} from "session"; export const PAGE_POLICY={...DEFAULT_POLICY,senderConstraint:"dpop_optional"};`,
  };
  return {
    name: "policy-cycle-fixture",
    resolveId(id) {
      if (id in sources) return `\0${id}`;
    },
    load(id) {
      return sources[id.slice(1)];
    },
  };
}

async function emittedPolicy(dir, pinned) {
  return build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [fixturePlugin()],
    build: {
      outDir: dir,
      modulePreload: false,
      emptyOutDir: false,
      target: "esnext",
      minify: true,
      rollupOptions: {
        input: "entry",
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          onlyExplicitManualChunks: true,
          manualChunks(id) {
            if (id === policy) return "session-connections";
            if (id === state)
              return (
                (pinned && lazyLeafChunk(id, classification)) ||
                "cap-connectors.external"
              );
            if (id === "\0session") return "session-connections";
            if (id === "\0runtime") return "cap-connectors.external";
          },
        },
      },
    },
  });
}

it.each([false, true])("emitted policy cycle pinned=%s", async (pinned) => {
  const dir = mkdtempSync(join(tmpdir(), "model-policy-chunk-"));
  try {
    const result = await emittedPolicy(dir, pinned);
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const entry = result.output.find(
      (item) => item.type === "chunk" && item.isEntry,
    );
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      const load=()=>import(${JSON.stringify(pathToFileURL(join(dir, entry.fileName)).href)});
      ${pinned ? `const {policy,broker}=await load(); assert.equal(broker,null); assert.equal(policy.senderConstraint,'dpop_optional');assert.equal(policy.maxLifetimeSeconds,3600);assert.equal(policy.rootMaxLifetimeSeconds,28800);assert.equal(policy.defaultLifetimeSeconds,900);assert.equal(policy.maxDelegationDepth,2);assert.equal(policy.outputTokenCeiling,32768);` : "await assert.rejects(load,{name:'ReferenceError',message:/before initialization/});"}
    `,
      ],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps shared panel helpers separate without changing their capability owner", () => {
  const helper = fileURLToPath(
    new URL(
      "../src/modules/connectors.external/native-oauth-resource-runtime.ts",
      import.meta.url,
    ),
  );
  assert.equal(lazyLeafChunk(state, classification), "model-key-state");
  assert.equal(
    lazyLeafChunk(helper, classification),
    "native-oauth-resource-runtime",
  );
  assert.equal(
    lazyLeafChunk(helper.replaceAll("/", "\\"), classification),
    "native-oauth-resource-runtime",
  );
  assert.equal(
    lazyLeafChunk(helper, { classification: "core", capability: null }),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(state, {
      classification: "optional",
      capability: "sharing.live",
    }),
    undefined,
  );
});
