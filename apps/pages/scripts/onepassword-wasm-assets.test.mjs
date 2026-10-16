import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ONEPASSWORD_ASSETS,
  ONEPASSWORD_SDK,
  adaptOnePasswordGlue,
  assertOnePasswordHash,
  loadOnePasswordAssets,
  onePasswordPackageRoot,
} from "./onepassword-wasm-assets.mjs";
const packageRoot = onePasswordPackageRoot();
const original = readFileSync(join(packageRoot, "nodejs/core.js"), "utf8");
const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture({
  name = ONEPASSWORD_SDK.package,
  version = ONEPASSWORD_SDK.version,
  glue = original,
  wasm,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "opensesame-onepassword-assets-"));
  temporary.push(root);
  mkdirSync(join(root, "nodejs"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name, version, license: "MIT" }),
  );
  writeFileSync(join(root, "nodejs/core.js"), glue);
  if (wasm) writeFileSync(join(root, "nodejs/core_bg.wasm"), wasm);
  else
    symlinkSync(
      join(packageRoot, "nodejs/core_bg.wasm"),
      join(root, "nodejs/core_bg.wasm"),
    );
  return root;
}
it("reads the real pinned dependency without executing its Node entry and returns unchanged WASM", () => {
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
  const wasm = assets.get(ONEPASSWORD_ASSETS.wasm);
  expect(
    wasm.equals(readFileSync(join(packageRoot, "nodejs/core_bg.wasm"))),
  ).toBe(true);
  expect(wasm.length).toBe(13_954_367);
  expect(wasm.length).toBeLessThan(15 * 1024 * 1024);
  expect(createHash("sha256").update(wasm).digest("hex")).toBe(
    "97aa9140c5c923b39b41c059d5ab98e214b5fc78a80203d0026708cfbce8d6ab",
  );
  expect([...assets.keys()].sort()).toEqual(
    Object.values(ONEPASSWORD_ASSETS).sort(),
  );
});
it("preserves every upstream business statement and adds only static browser bootstrap", () => {
  const runtime = loadOnePasswordAssets().get(ONEPASSWORD_ASSETS.runtime);
  expect(runtime.match(/const module = \{ exports: \{\} \};/g)).toHaveLength(1);
  expect(runtime.match(/const wasmURL = new URL\(/g)).toHaveLength(1);
  expect(runtime.match(/export const sdk = module.exports;/g)).toHaveLength(1);
  expect(original.match(/require\(`util`\)/g)).toHaveLength(1);
  expect(original.match(/const path = require\('path'\)/g)).toHaveLength(1);
  expect(runtime).not.toMatch(/require\(|__dirname/);
  expect(runtime.match(/new Function\(/g)).toHaveLength(
    original.match(/new Function\(/g).length,
  );
  const business = original
    .slice(
      original.indexOf("let imports = {}"),
      original.indexOf("const path = require('path')"),
    )
    .replace("const { TextDecoder, TextEncoder } = require(`util`);", "");
  expect(
    runtime.slice(
      runtime.indexOf("let imports = {}"),
      runtime.indexOf("const wasmURL ="),
    ),
  ).toBe(business);
  assertOnePasswordHash(runtime, ONEPASSWORD_SDK.runtimeHash);
  expect(runtime).toContain("await WebAssembly.instantiate(bytes, imports)");
});
it.each([
  "https://operator.example/",
  "https://operator.example/OpenSesame/",
  "https://operator.example/tenant/pwa/",
])("resolves emitted WASM beside its module under %s", (base) => {
  const runtime = loadOnePasswordAssets().get(ONEPASSWORD_ASSETS.runtime);
  const match = runtime.match(
    /const wasmURL = new URL\(("[^"]+"), import.meta.url\);/,
  );
  expect(match).not.toBeNull();
  const relative = JSON.parse(match[1]);
  expect(
    new URL(relative, new URL(ONEPASSWORD_ASSETS.runtime, base)).href,
  ).toBe(new URL(ONEPASSWORD_ASSETS.wasm, base).href);
  expect(runtime).toContain("await fetch(wasmURL)");
});
it("includes the complete unchanged pinned MIT notice absent from the published tarball", () => {
  const notice = loadOnePasswordAssets().get(ONEPASSWORD_ASSETS.license);
  expect(
    notice.equals(
      readFileSync(
        new URL("./vendor/onepassword-sdk.LICENSE", import.meta.url),
      ),
    ),
  ).toBe(true);
  expect(createHash("sha256").update(notice).digest("hex")).toBe(
    "73640cd487337718201bbec4ae0b9bcdac152192ddf263d927e27a98a30da6b1",
  );
  expect(notice.toString()).toContain("Copyright (c) 2024 1Password");
  expect(notice.toString()).toContain("THE SOFTWARE IS PROVIDED");
  expect(ONEPASSWORD_SDK.licenseSource).toContain(ONEPASSWORD_SDK.sourceCommit);
  expect(() =>
    assertOnePasswordHash(
      Buffer.from("changed notice"),
      ONEPASSWORD_SDK.licenseHash,
    ),
  ).toThrow(/digest/);
});
it.each([{ version: "0.5.1" }, { name: "another-package" }])(
  "rejects an unpinned package before adaptation: %j",
  (change) => {
    expect(() => loadOnePasswordAssets(fixture(change))).toThrow(
      /package\/version/,
    );
  },
);
it.each([
  "",
  "modified core",
  `${original}\nconst { TextDecoder, TextEncoder } = require(\`util\`);`,
])(
  "refuses altered/missing/duplicated glue before it can be emitted",
  (glue) => {
    expect(() => loadOnePasswordAssets(fixture({ glue }))).toThrow(/digest/);
  },
);
it("rejects modified WASM and does not mutate the real dependency while testing failures", () => {
  expect(() =>
    loadOnePasswordAssets(fixture({ wasm: Buffer.from("not-wasm") })),
  ).toThrow(/digest/);
  const bytes = readFileSync(join(packageRoot, "nodejs/core_bg.wasm"));
  assertOnePasswordHash(bytes, ONEPASSWORD_SDK.wasmHash);
});
it("keeps this asset foundation unactivated until an actual worker owns it", () => {
  const vite = readFileSync(
    new URL("../vite.config.ts", import.meta.url),
    "utf8",
  );
  expect(vite).not.toContain("onepassword-wasm-assets");
  expect(adaptOnePasswordGlue(original)).toContain(
    "export const sdk = module.exports;",
  );
});
