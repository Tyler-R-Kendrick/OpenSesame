#!/usr/bin/env node
/** Cold-load emitted schema dependencies with no document boot or inherited Zod config. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SourceTextModule, createContext } from "node:vm";

const dist = resolve(process.argv[2] ?? "dist");
const graph = JSON.parse(
  await readFile(resolve(dist, "capability-graph.json"), "utf8"),
);
const main = graph.entries.find((entry) => entry.html === "index.html");
assert.ok(main?.scripts.length, "Built index must name its module entry");

function coldRealm(file) {
  const messages = [];
  const listeners = new Map();
  let network = 0;
  const context = createContext(
    {
      URL,
      EventTarget,
      Event,
      TextEncoder,
      TextDecoder,
      Response,
      Request,
      Headers,
      AbortController,
      AbortSignal,
      crypto,
      performance,
      setTimeout,
      clearTimeout,
      atob,
      btoa,
      // The only document access in the static closure is Vite's preload feature probe.
      document: {
        createElement: () => ({ relList: { supports: () => true } }),
      },
      location: new URL(`https://app.example.test/${file}`),
      addEventListener: (kind, callback) => listeners.set(kind, callback),
      postMessage: (value) => messages.push(value),
      fetch: () => {
        network++;
        throw new Error("Cold schema loading must not access the network");
      },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  return {
    context,
    messages,
    listeners,
    assertNoNetwork() {
      assert.equal(network, 0, `${file}: no startup network`);
    },
  };
}

async function installMonitor(context) {
  const monitor = new SourceTextModule(
    `globalThis.self=globalThis;globalThis.evalAttempts=0;
globalThis.Function=new Proxy(Function,{apply(target,receiver,args){globalThis.evalAttempts++;return Reflect.apply(target,receiver,args)},construct(target,args){globalThis.evalAttempts++;return Reflect.construct(target,args)}});`,
    { context },
  );
  await monitor.link(() => {
    throw new Error("Monitor has no dependencies");
  });
  await monitor.evaluate();
}

function moduleLoader(context) {
  const modules = new Map();
  async function load(name) {
    if (!modules.has(name)) {
      modules.set(
        name,
        readFile(resolve(dist, name), "utf8").then(
          (source) =>
            new SourceTextModule(source, {
              context,
              identifier: name,
              initializeImportMeta(meta) {
                meta.url = `https://app.example.test/${name}`;
              },
            }),
        ),
      );
    }
    return modules.get(name);
  }
  return load;
}

async function assertWorkerInput(file, context, messages, listeners) {
  if (file.includes("bitwarden-secrets.worker-")) {
    context.onmessage({ origin: "https://foreign.example.test", data: {} });
    context.onmessage({
      origin: "",
      data: { type: "initialize", id: 1, settings: {} },
    });
    await new Promise((done) => setTimeout(done, 0));
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
      { id: -1, ok: false, result: "" },
    ]);
  }
  if (file.includes("tailscale-node-")) {
    listeners.get("message")({
      origin: "",
      data: { kind: "start", config: {} },
      ports: [],
    });
    assert.deepEqual(messages, []);
  }
}

async function coldLoad(file, dependenciesOnly) {
  const { context, messages, listeners, assertNoNetwork } = coldRealm(file);
  await installMonitor(context);
  const load = moduleLoader(context);
  const actual = await load(file);
  // Preserve the shipped main's exact dependency order, without starting its UI body.
  const entry = dependenciesOnly
    ? new SourceTextModule(
        actual.dependencySpecifiers
          .map((specifier) => `import ${JSON.stringify(specifier)};`)
          .join("\n"),
        { context, identifier: file },
      )
    : actual;
  await entry.link((specifier, parent) =>
    load(new URL(specifier, `file:///${parent.identifier}`).pathname.slice(1)),
  );
  await entry.evaluate({ timeout: 5000 });
  await assertWorkerInput(file, context, messages, listeners);
  assertNoNetwork();
  assert.equal(
    context.evalAttempts,
    0,
    `${file}: no dynamic compilation probes`,
  );
  assert.equal(
    context.__zod_globalConfig?.jitless,
    true,
    `${file}: schema configuration must be initialized`,
  );
}

for (const file of main.scripts) await coldLoad(file, true);
const variants = new Set([
  "module:bitwarden-native.worker",
  "module:bitwarden-secrets.worker",
  "module:onepassword-sdk.worker",
  "module:tailscale-node",
]);
for (const worker of graph.workers) {
  if (worker.present && variants.has(worker.variant))
    await coldLoad(worker.file, false);
}
