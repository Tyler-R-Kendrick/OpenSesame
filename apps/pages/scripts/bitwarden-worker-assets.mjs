/** Admit only the exact maintained BWS browser glue and its pinned gzip-delivered WASM. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import artifact from "../../../packages/app-core/src/lib/secret-backends/bitwarden-wasm-artifact.json" with {
  type: "json",
};

const realm = "bitwarden-secrets.worker";
const pins = new Map([
  [
    "package.json",
    "d2e33beab14da66f9d906643433fcd9ec2296b9627c4ab0658943070a5505e73",
  ],
  [
    "bitwarden_wasm_bg.js",
    "50eb3fec03447de7867a2f72e2df0b26dd772dc1526a84d440aa4ee602e3f106",
  ],
  [
    "bitwarden_wasm_bg.wasm",
    "3722dfbef74f28d49c8e70aeeb532a4be21a1884abcc6292f0d1a58b0c612861",
  ],
]);
const wasmName = "bitwarden_wasm_bg.wasm";

/** Mutable wasm-bindgen state stays virtualized in this realm, never shared with the host. */
export function bitwardenWorkerAssets(workers) {
  const owner = workers.find((plan) => plan.name === realm);
  if (!owner) return undefined;
  const root = dirname(
    createRequire(owner.owner).resolve("@bitwarden/sdk-wasm/package.json"),
  );
  function pinned(name) {
    const file = join(root, name);
    if (!pins.has(name) || realpathSync(file) !== file)
      throw new Error("BWS worker needs a canonical pinned browser asset.");
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== pins.get(name))
      throw new Error("BWS worker browser asset digest differs.");
    return bytes;
  }
  const metadata = JSON.parse(pinned("package.json"));
  if (metadata.name !== "@bitwarden/sdk-wasm" || metadata.version !== "0.1.0")
    throw new Error("BWS worker SDK package/version differs.");
  const wasm = join(root, wasmName);
  const glue = join(root, "bitwarden_wasm_bg.js");
  const raw = pinned(wasmName);
  const compressed = gzipSync(raw, { level: 9 });
  for (const [bytes, pin] of [
    [raw, artifact.raw],
    [compressed, artifact.compressed],
  ]) {
    if (
      bytes.length !== pin.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== pin.hash
    )
      throw new Error("BWS worker WASM transport pin differs.");
  }
  pinned("bitwarden_wasm_bg.js");
  return {
    owns(file, target) {
      return target === realm && (file === wasm || file === glue);
    },
    resolve(file, target) {
      return target === realm && file === `${wasm}?url` ? wasm : file;
    },
    load(context, file) {
      if (file === glue) return pinned("bitwarden_wasm_bg.js").toString("utf8");
      if (file !== wasm) return undefined;
      const reference = context.emitFile({
        type: "asset",
        name: `${wasmName}.gz`,
        source: compressed,
      });
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    },
  };
}
