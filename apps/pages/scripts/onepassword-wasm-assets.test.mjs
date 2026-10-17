import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  makeFixtureTree,
  policy,
  profileFile,
  selection,
} from "./lib/capability-fixtures.mjs";
import {
  ONEPASSWORD_ASSETS,
  ONEPASSWORD_SDK,
  assertOnePasswordHash,
  attachOnePasswordAssets,
  loadOnePasswordAssets,
  onePasswordPackageRoot,
  onePasswordWasmAssets,
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
it.each(["length", "digest"])(
  "rejects modified WASM %s without mutating the dependency",
  (change) => {
    const bytes =
      change === "length"
        ? Buffer.from("not-wasm")
        : readFileSync(join(packageRoot, "nodejs/core_bg.wasm"));
    if (change === "digest") bytes[0] ^= 1;
    expect(() => loadOnePasswordAssets(fixture({ wasm: bytes }))).toThrow(
      new RegExp(change),
    );
    assertOnePasswordHash(
      readFileSync(join(packageRoot, "nodejs/core_bg.wasm")),
      ONEPASSWORD_SDK.wasmHash,
    );
  },
);
it("registers the owner-gated asset plugin without changing ES worker naming", () => {
  const vite = readFileSync(
    new URL("../vite.config.ts", import.meta.url),
    "utf8",
  );
  expect(vite).toContain("onePasswordWasmAssets()");
  expect(vite).toContain('format: "es"');
  expect(vite).toContain("entryFileNames: tailscaleWorkerFileName");
});

const worker = "assets/onepassword-sdk.worker-aBc123_-.js";
const source = "/repo/packages/app-core/src/lib/secret-backends/";
const optional = () => ({
  classification: "optional",
  capability: "connectors.external",
});
function ownedBundle(base = "/OpenSesame/") {
  return {
    "assets/native.js": {
      type: "chunk",
      name: "unrelated-name",
      modules: { [`${source}onepassword-sdk-loader.ts`]: {} },
      code: `new Worker(new URL(${JSON.stringify(`${base}${worker}`)}, import.meta.url), {type:"module"})`,
      viteMetadata: {
        importedAssets: new Set(["assets/keep.svg"]),
        importedCss: new Set(["assets/keep.css"]),
      },
    },
    "assets/common.js": {
      type: "chunk",
      modules: { [`${source}onepassword.ts`]: {} },
    },
    [worker]: { type: "asset", source: "actual emitted worker fixture" },
  };
}
async function pluginFor({ base = "/OpenSesame/", excluded = false } = {}) {
  const tree = makeFixtureTree();
  temporary.push(tree.tmpRoot);
  const loadAssets = vi.fn(loadOnePasswordAssets);
  const plugin = onePasswordWasmAssets({
    appRoot: tree.appRoot,
    repoRoot: tree.tmpRoot,
    inventory: {
      ...tree.inventory,
      classification: [
        {
          pattern: "src/lib/secret-backends/",
          ...optional(),
          rationale: "backup providers",
        },
      ],
    },
    mode: excluded ? "hardened" : "selective",
    profilePath: excluded
      ? profileFile(tree, "without-connectors", {
          instancePolicy: policy([], []),
          installationSelection: selection([], []),
        })
      : undefined,
    env: {},
    logger: { warn() {} },
    loadAssets,
  });
  await plugin.config({ base }, { command: "build" });
  return { plugin, loadAssets, emitFile: vi.fn() };
}
it("attaches four actual dependencies only to an exclusively owned native leaf", () => {
  const bundle = ownedBundle();
  expect(attachOnePasswordAssets(bundle, optional, "/OpenSesame/")).toBe(true);
  expect(
    [...bundle["assets/native.js"].viteMetadata.importedAssets].sort(),
  ).toEqual(
    [...Object.values(ONEPASSWORD_ASSETS), worker, "assets/keep.svg"].sort(),
  );
  expect([...bundle["assets/native.js"].viteMetadata.importedCss]).toEqual([
    "assets/keep.css",
  ]);
  expect(bundle["assets/common.js"].viteMetadata).toBeUndefined();
  expect(bundle[worker].viteMetadata).toBeUndefined();
});
it.each([
  "onepassword.ts",
  "factory.ts",
  "onepassword-artifacts.json",
  "bitwarden.worker.ts",
])(
  "does not load or emit orphan SDK assets for %s, regardless of chunk name",
  async (name) => {
    const { plugin, loadAssets, emitFile } = await pluginFor();
    const bundle = {
      common: {
        type: "chunk",
        name: "secret-backend-onepassword-sdk",
        modules: { [`${source}${name}`]: {} },
      },
    };
    plugin.generateBundle.call({ emitFile }, {}, bundle);
    expect(loadAssets).not.toHaveBeenCalled();
    expect(emitFile).not.toHaveBeenCalled();
  },
);
it("hardened exclusion suppresses build emission and dev middleware before loading bytes", async () => {
  const { plugin, loadAssets, emitFile } = await pluginFor({ excluded: true });
  const use = vi.fn();
  plugin.configureServer({ middlewares: { use } });
  plugin.generateBundle.call({ emitFile }, {}, ownedBundle());
  expect(use).not.toHaveBeenCalled();
  expect(loadAssets).not.toHaveBeenCalled();
  expect(emitFile).not.toHaveBeenCalled();
});
it("loads verified package bytes once and emits exactly the three pinned files", async () => {
  const { plugin, loadAssets, emitFile } = await pluginFor();
  expect(loadAssets).not.toHaveBeenCalled();
  plugin.generateBundle.call({ emitFile }, {}, ownedBundle());
  plugin.generateBundle.call({ emitFile }, {}, ownedBundle());
  expect(loadAssets).toHaveBeenCalledTimes(1);
  expect(emitFile.mock.calls.length).toBe(6);
  const emitted = emitFile.mock.calls.slice(0, 3).map(([asset]) => asset);
  expect(emitted.map(({ fileName }) => fileName).sort()).toEqual(
    Object.values(ONEPASSWORD_ASSETS).sort(),
  );
  const assets = loadAssets.mock.results[0].value;
  for (const asset of emitted)
    expect(asset.source === assets.get(asset.fileName)).toBe(true);
});
it("rejects ambiguous/missing owners and workers before package loading or emission", async () => {
  const { plugin, loadAssets, emitFile } = await pluginFor();
  const cases = [];
  let bundle = ownedBundle();
  delete bundle[worker];
  cases.push([bundle, /exactly one emitted/]);
  bundle = ownedBundle();
  bundle["assets/onepassword-sdk.worker-second.js"] = {
    type: "asset",
    source: "duplicate",
  };
  cases.push([bundle, /exactly one emitted/]);
  bundle = ownedBundle();
  bundle[worker].type = "chunk";
  bundle[worker].modules = {};
  cases.push([bundle, /exactly one emitted/]);
  bundle = ownedBundle();
  bundle["assets/native.js"].modules = {
    [`${source}onepassword-sdk-codec.ts`]: {},
  };
  cases.push([bundle, /native loader/]);
  bundle = ownedBundle();
  bundle.other = { ...bundle["assets/native.js"] };
  cases.push([bundle, /one owning chunk/]);
  bundle = ownedBundle();
  bundle["assets/native.js"].modules[`${source}onepassword.ts`] = {};
  cases.push([bundle, /exclusively native/]);
  for (const [output, error] of cases)
    expect(() => plugin.generateBundle.call({ emitFile }, {}, output)).toThrow(
      error,
    );
  expect(loadAssets).not.toHaveBeenCalled();
  expect(emitFile).not.toHaveBeenCalled();
});
it("requires an exact parsed worker URL reference, not a comment, near filename or remote path", () => {
  for (const code of [
    `// new URL("/OpenSesame/${worker}", import.meta.url)`,
    `new URL("/OpenSesame/${worker}.other", import.meta.url)`,
    `new URL("https://other.example/OpenSesame/${worker}", import.meta.url)`,
  ]) {
    const bundle = ownedBundle();
    bundle["assets/native.js"].code = code;
    expect(() =>
      attachOnePasswordAssets(bundle, optional, "/OpenSesame/"),
    ).toThrow(/reference its emitted worker/);
    expect([...bundle["assets/native.js"].viteMetadata.importedAssets]).toEqual(
      ["assets/keep.svg"],
    );
  }
  const bundle = ownedBundle();
  expect(
    attachOnePasswordAssets(bundle, () => ({
      classification: "shared",
      capability: null,
    })),
  ).toBe(false);
});
it.each(["/", "/OpenSesame/", "/operator/nested/pwa/"])(
  "serves only exact static resources lazily with correct MIME under %s",
  async (base) => {
    const { plugin, loadAssets } = await pluginFor({ base });
    const use = vi.fn();
    plugin.configureServer({ middlewares: { use } });
    const middleware = use.mock.calls[0][0];
    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    for (const url of [
      "/unrelated",
      `${base}onepassword/../package.json`,
      `${base}onepassword/%2e%2e/package.json`,
      `${base}${ONEPASSWORD_ASSETS.wasm}/extra`,
      `/wrong${base}${ONEPASSWORD_ASSETS.wasm}`,
    ])
      middleware({ url, method: "GET" }, res, next);
    middleware(
      { url: `${base}${ONEPASSWORD_ASSETS.wasm}`, method: "POST" },
      res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(6);
    expect(loadAssets).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    for (const [file, mime] of [
      [ONEPASSWORD_ASSETS.wasm, "application/gzip"],
      [ONEPASSWORD_ASSETS.runtime, "text/javascript"],
      [ONEPASSWORD_ASSETS.license, "text/plain; charset=utf-8"],
    ]) {
      middleware({ url: `${base}${file}?v=pin`, method: "GET" }, res, next);
      expect(res.setHeader).toHaveBeenLastCalledWith("Content-Type", mime);
      const body = res.end.mock.calls.at(-1)[0];
      expect(body === loadAssets.mock.results[0].value.get(file)).toBe(true);
    }
    middleware(
      { url: `${base}${ONEPASSWORD_ASSETS.wasm}`, method: "HEAD" },
      res,
      next,
    );
    expect(res.end).toHaveBeenLastCalledWith(undefined);
    expect(loadAssets).toHaveBeenCalledTimes(1);
    expect(
      res.setHeader.mock.calls.some(
        ([name]) => name.toLowerCase() === "content-encoding",
      ),
    ).toBe(false);
  },
);
