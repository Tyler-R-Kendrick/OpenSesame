/** Emit pinned SDK assets only for their distributed native worker owner. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { gzipSync } from "node:zlib";
import ts from "typescript";
import { composeState } from "./lib/capability-compose-state.mjs";
import { secretBackendSdkChunk } from "./lib/capability-lazy-leaves.mjs";

const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/app-core/src/lib/secret-backends/onepassword-artifacts.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
export const ONEPASSWORD_SDK = Object.freeze(manifest.sdk);
export const ONEPASSWORD_ASSETS = Object.freeze(manifest.assets);
const UTIL = "const { TextDecoder, TextEncoder } = require(`util`);";
const BOOTSTRAP = `const path = require('path').join(__dirname, 'core_bg.wasm');
const bytes = require('fs').readFileSync(path);

const wasmModule = new WebAssembly.Module(bytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, imports);
wasm = wasmInstance.exports;
module.exports.__wasm = wasm;

wasm.__wbindgen_start();`;

// SHA-256 over pinned SDK artifact bytes (wasm/glue/license) checked
// against the committed manifest digests — a supply-chain pin, and the
// input is never a password.
export function assertOnePasswordHash(bytes, expected) {
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(
      "Pinned 1Password artifact digest differs; review the SDK upgrade.",
    );
}
function replaceOnce(source, expected, replacement) {
  if (source.split(expected).length !== 2)
    throw new Error("Unexpected 1Password bootstrap statement count.");
  return source.replace(expected, replacement);
}
/** Keep every upstream business function intact, including its wasm-bindgen imports. */
export function adaptOnePasswordGlue(source) {
  assertOnePasswordHash(source, ONEPASSWORD_SDK.glueHash);
  const bootstrap = `const wasmURL = new URL(${JSON.stringify(`./${posix.basename(ONEPASSWORD_ASSETS.wasm)}`)}, import.meta.url);
const response = await fetch(wasmURL);
if (!response.ok) throw new Error("Could not load the 1Password SDK asset.");
const bytes = await response.arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes, imports);
wasm = instance.exports;
module.exports.__wasm = wasm;
wasm.__wbindgen_start();
export const sdk = module.exports;`;
  return `const module = { exports: {} };\n${replaceOnce(replaceOnce(source, UTIL, ""), BOOTSTRAP, bootstrap)}`;
}
/** Resolve raw artifacts from their owning package without executing the Node entry. */
export function onePasswordPackageRoot() {
  const require = createRequire(
    new URL("../../../packages/app-core/package.json", import.meta.url),
  );
  return dirname(require.resolve("@1password/sdk-core/package.json"));
}
export function loadOnePasswordAssets(packageRoot = onePasswordPackageRoot()) {
  const pkg = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  if (
    pkg.name !== ONEPASSWORD_SDK.package ||
    pkg.version !== ONEPASSWORD_SDK.version ||
    pkg.license !== ONEPASSWORD_SDK.license
  )
    throw new Error("Unpinned 1Password SDK package/version.");
  const wasm = readFileSync(join(packageRoot, "nodejs/core_bg.wasm"));
  if (wasm.length !== ONEPASSWORD_SDK.wasmBytes)
    throw new Error("Pinned 1Password raw WASM length differs.");
  assertOnePasswordHash(wasm, ONEPASSWORD_SDK.wasmHash);
  const compressed = gzipSync(wasm, { level: ONEPASSWORD_SDK.wasmGzipLevel });
  if (compressed.length !== ONEPASSWORD_SDK.wasmGzipBytes)
    throw new Error("Pinned 1Password compressed WASM length differs.");
  assertOnePasswordHash(compressed, ONEPASSWORD_SDK.wasmGzipHash);
  const runtime = adaptOnePasswordGlue(
    readFileSync(join(packageRoot, "nodejs/core.js"), "utf8"),
  );
  assertOnePasswordHash(runtime, ONEPASSWORD_SDK.runtimeHash);
  const license = readFileSync(
    new URL("./vendor/onepassword-sdk.LICENSE", import.meta.url),
  );
  assertOnePasswordHash(license, ONEPASSWORD_SDK.licenseHash);
  return new Map([
    [ONEPASSWORD_ASSETS.wasm, compressed],
    [ONEPASSWORD_ASSETS.runtime, runtime],
    [ONEPASSWORD_ASSETS.license, license],
  ]);
}

function sdkOwner(bundle, classify) {
  const owners = Object.entries(bundle).filter(
    ([, output]) =>
      output.type === "chunk" &&
      Object.keys(output.modules).some(
        (id) => secretBackendSdkChunk(id, classify(id)) !== undefined,
      ),
  );
  if (owners.length === 0) return undefined;
  if (owners.length !== 1)
    throw new Error("1Password SDK assets need exactly one owning chunk.");
  const [file, output] = owners[0];
  const nativeIds = Object.keys(output.modules).filter(
    (id) => secretBackendSdkChunk(id, classify(id)) !== undefined,
  );
  if (nativeIds.length !== Object.keys(output.modules).length)
    throw new Error(
      "1Password SDK assets need an exclusively native SDK chunk.",
    );
  if (
    !nativeIds.some((id) =>
      id
        .replaceAll("\\", "/")
        .split(/[?#]/, 1)[0]
        .endsWith("/onepassword-sdk-loader.ts"),
    )
  )
    throw new Error("1Password SDK assets need their native loader.");
  return { file, output };
}

function referencesWorker(owner, worker, base) {
  const root = new URL(base, "https://opensesame-build.invalid/");
  const target = new URL(worker, root).href;
  const ast = ts.createSourceFile(
    owner.file,
    owner.output.code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(ast) === "URL" &&
      node.arguments?.length === 2 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[1].getText(ast) === "import.meta.url"
    ) {
      if (
        new URL(node.arguments[0].text, new URL(owner.file, root)).href ===
        target
      )
        return true;
    }
    return ts.forEachChild(node, visit);
  };
  return visit(ast) === true;
}

/** Attach actual emitted dependencies only to the classified native SDK leaf. */
export function attachOnePasswordAssets(bundle, classify, base = "/") {
  const owner = sdkOwner(bundle, classify);
  if (!owner) return false;
  const workers = Object.keys(bundle).filter(
    (file) =>
      bundle[file].type === "asset" &&
      /^assets\/onepassword-sdk\.worker-[A-Za-z0-9_-]+\.js$/.test(file),
  );
  if (workers.length !== 1)
    throw new Error(
      "1Password SDK needs exactly one emitted dedicated worker.",
    );
  if (!referencesWorker(owner, workers[0], base))
    throw new Error(
      "1Password native loader must reference its emitted worker.",
    );
  owner.output.viteMetadata ??= {};
  owner.output.viteMetadata.importedAssets ??= new Set();
  for (const file of [...Object.values(ONEPASSWORD_ASSETS), workers[0]])
    owner.output.viteMetadata.importedAssets.add(file);
  return true;
}

/** Build-only injection keeps tests on the same compose-state and pin-loading paths. */
export function onePasswordWasmAssets({
  loadAssets = loadOnePasswordAssets,
  ...options
} = {}) {
  let state;
  let base = "/";
  let assets;
  const contentTypes = new Map([
    [ONEPASSWORD_ASSETS.wasm, "application/gzip"],
    [ONEPASSWORD_ASSETS.runtime, "text/javascript"],
    [ONEPASSWORD_ASSETS.license, "text/plain; charset=utf-8"],
  ]);
  return {
    name: "opensesame-onepassword-wasm-assets",
    async config(config, { command }) {
      state = await composeState(options, config, command);
      base = config.base ?? "/";
    },
    configureServer(server) {
      if (!state || state.isExcluded("connectors.external")) return;
      const pathBase = new URL(
        base,
        "https://opensesame-dev.invalid/",
      ).pathname.replace(/\/?$/, "/");
      const paths = new Map(
        [...contentTypes.keys()].map((file) => [`${pathBase}${file}`, file]),
      );
      server.middlewares.use((req, res, next) => {
        const file = paths.get(req.url?.split("?", 1)[0]);
        if (!file || !["GET", "HEAD"].includes(req.method)) return next();
        assets ??= loadAssets();
        res.setHeader("Content-Type", contentTypes.get(file));
        res.end(req.method === "HEAD" ? undefined : assets.get(file));
      });
    },
    generateBundle(_options, bundle) {
      if (!state || state.isExcluded("connectors.external")) return;
      if (!attachOnePasswordAssets(bundle, state.classify, base)) return;
      assets ??= loadAssets();
      for (const [fileName, source] of assets)
        this.emitFile({ type: "asset", fileName, source });
    },
  };
}
