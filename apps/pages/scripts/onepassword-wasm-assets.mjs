/** Prepare pinned SDK assets; production activation awaits an owning worker. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";

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
  assertOnePasswordHash(wasm, ONEPASSWORD_SDK.wasmHash);
  const runtime = adaptOnePasswordGlue(
    readFileSync(join(packageRoot, "nodejs/core.js"), "utf8"),
  );
  assertOnePasswordHash(runtime, ONEPASSWORD_SDK.runtimeHash);
  const license = readFileSync(
    new URL("./vendor/onepassword-sdk.LICENSE", import.meta.url),
  );
  assertOnePasswordHash(license, ONEPASSWORD_SDK.licenseHash);
  return new Map([
    [ONEPASSWORD_ASSETS.wasm, wasm],
    [ONEPASSWORD_ASSETS.runtime, runtime],
    [ONEPASSWORD_ASSETS.license, license],
  ]);
}
