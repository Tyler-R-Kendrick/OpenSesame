import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import {
  ONEPASSWORD_ASSETS,
  ONEPASSWORD_SDK,
  loadOnePasswordAssets,
  onePasswordPackageRoot,
} from "./onepassword-wasm-assets.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
it("compresses the actual pinned dependency without executing its Node entry or changing WASM", () => {
  const require = createRequire(
    new URL("../../../packages/app-core/package.json", import.meta.url),
  );
  const entry = require.resolve("@1password/sdk-core");
  expect(require.cache[entry]).toBeUndefined();
  const assets = loadOnePasswordAssets();
  expect(require.cache[entry]).toBeUndefined();
  expect(ONEPASSWORD_SDK.version).toBe("0.5.0");
  expect(ONEPASSWORD_SDK.build).toBe("0050002");
  expect(ONEPASSWORD_SDK.integrity).toBe(
    "sha512-9g7LWOKRKdePZ85evVgE9xEom3DAg3hRIyQdOwLPvpL/F7KpDXmUHMi72rsqJxKaDbWApXmrYjDExMSPqUg7xw==",
  );
  const compressed = assets.get(ONEPASSWORD_ASSETS.wasm);
  expect(compressed.length).toBe(ONEPASSWORD_SDK.wasmGzipBytes);
  expect(hash(compressed)).toBe(ONEPASSWORD_SDK.wasmGzipHash);
  const wasm = gunzipSync(compressed);
  const original = readFileSync(
    join(onePasswordPackageRoot(), "nodejs/core_bg.wasm"),
  );
  expect(wasm.equals(original)).toBe(true);
  expect(wasm.length).toBe(13_954_367);
  expect(hash(wasm)).toBe(
    "97aa9140c5c923b39b41c059d5ab98e214b5fc78a80203d0026708cfbce8d6ab",
  );
  expect([...assets.keys()].sort()).toEqual(
    Object.values(ONEPASSWORD_ASSETS).sort(),
  );
  expect(ONEPASSWORD_SDK.wasmCompression).toBe("gzip");
  expect(ONEPASSWORD_SDK.wasmGzipLevel).toBe(9);
  expect(compressed.subarray(0, 10).toString("hex")).toBe(
    "1f8b0800000000000203",
  );
});
it("pins the changed adjacent transport filename and runtime while emitting no raw fallback", () => {
  const first = loadOnePasswordAssets();
  const second = loadOnePasswordAssets();
  expect(
    first
      .get(ONEPASSWORD_ASSETS.wasm)
      .equals(second.get(ONEPASSWORD_ASSETS.wasm)),
  ).toBe(true);
  const runtime = first.get(ONEPASSWORD_ASSETS.runtime);
  expect(hash(runtime)).toBe(ONEPASSWORD_SDK.runtimeHash);
  expect(ONEPASSWORD_ASSETS.wasm).toBe(
    "onepassword/core-0.5.0-7cc0e700.wasm.gz",
  );
  expect(ONEPASSWORD_ASSETS.runtime).toBe(
    "onepassword/core-0.5.0-764c359d.mjs",
  );
  expect(runtime).toContain('"./core-0.5.0-7cc0e700.wasm.gz"');
  expect(runtime).not.toContain('"./core-0.5.0-97aa9140.wasm"');
  expect([...first.keys()].some((file) => file.endsWith(".wasm"))).toBe(false);
});
it("reproduces committed gzip pins in independent processes without returning large bytes", () => {
  const moduleUrl = new URL("./onepassword-wasm-assets.mjs", import.meta.url)
    .href;
  const source = `import {createHash} from "node:crypto"; import {loadOnePasswordAssets,ONEPASSWORD_ASSETS} from ${JSON.stringify(moduleUrl)}; const bytes=loadOnePasswordAssets().get(ONEPASSWORD_ASSETS.wasm); process.stdout.write(JSON.stringify({pid:process.pid,bytes:bytes.length,hash:createHash("sha256").update(bytes).digest("hex")}));`;
  const run = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", source],
        { encoding: "utf8", maxBuffer: 4096 },
      ),
    );
  const first = run();
  const second = run();
  expect(first.pid).not.toBe(second.pid);
  for (const receipt of [first, second]) {
    expect(receipt.bytes).toBe(ONEPASSWORD_SDK.wasmGzipBytes);
    expect(receipt.hash).toBe(ONEPASSWORD_SDK.wasmGzipHash);
  }
});
