/** Produce only same-deployment, hash-named native runtime assets and notices. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { compressNativeWasm } from "./compress-wasm.mjs";

const hash = (data) => createHash("sha256").update(data).digest("hex");

async function nativeMinifier(repositoryRoot, pins) {
  const require = createRequire(
    join(repositoryRoot, "apps/pages/package.json"),
  );
  const packagePath = require.resolve("terser/package.json");
  const bytes = await readFile(packagePath);
  const license = await readFile(join(dirname(packagePath), "LICENSE"));
  if (
    JSON.parse(bytes).version !== "5.51.2" ||
    hash(bytes) !== pins.composition.terser.packageSha256 ||
    hash(license) !== pins.composition.terser.licenseSha256
  )
    throw new Error(
      "Native minification requires the exact declared Pages Terser dependency.",
    );
  const { minify } = await import(
    pathToFileURL(require.resolve("terser")).href
  );
  return async (source, expected) => {
    const result = await minify(source.toString("utf8"), {
      ecma: 2022,
      module: true,
      compress: { passes: 2 },
      mangle: true,
      format: { comments: /Copyright|license/ },
    });
    const bytes = Buffer.from(result.code ?? "");
    if (!bytes.length || hash(bytes) !== expected)
      throw new Error("Native minified runtime differs from its reviewed pin.");
    return bytes;
  };
}

async function bridgeBundle(here, repositoryRoot, pins) {
  const require = createRequire(join(repositoryRoot, "package.json"));
  const viteBytes = await readFile(require.resolve("vite/package.json"));
  if (
    JSON.parse(viteBytes).version !== "6.4.4" ||
    hash(viteBytes) !== pins.composition.vite.packageSha256
  )
    throw new Error(
      "Native composition requires the exact declared Vite dependency.",
    );
  const packagePath = require.resolve("zod/package.json");
  const packageBytes = await readFile(packagePath);
  const dependency = JSON.parse(packageBytes);
  if (
    dependency.version !== "4.6.6" ||
    hash(packageBytes) !== pins.composition.zod.packageSha256
  )
    throw new Error(
      "Native bridge requires the exact declared root Zod4 dependency.",
    );
  const license = await readFile(join(dirname(packagePath), "LICENSE"));
  if (hash(license) !== pins.composition.zod.licenseSha256)
    throw new Error("Native bridge dependency notice changed.");
  const built = await build({
    configFile: false,
    envDir: false,
    root: here,
    publicDir: false,
    logLevel: "silent",
    build: {
      write: false,
      sourcemap: false,
      minify: "esbuild",
      target: "es2022",
      lib: {
        entry: join(here, "native-http.mjs"),
        formats: ["es"],
        fileName: "native-http",
      },
    },
  });
  const outputs = Array.isArray(built) ? built : [built];
  const chunks = outputs.flatMap((output) => output.output);
  if (
    chunks.length !== 1 ||
    chunks[0].type !== "chunk" ||
    chunks[0].imports.length ||
    chunks[0].dynamicImports.length
  )
    throw new Error("Native bridge must be one standalone ESM asset.");
  const bytes = Buffer.from(chunks[0].code);
  if (hash(bytes) !== pins.composition.bridgeUnminifiedSha256)
    throw new Error(
      "Standalone native bridge graph differs from the pinned artifact.",
    );
  return { bytes, license };
}

async function ownedAsset(directory, prefix, extension, bytes) {
  const digest = hash(bytes);
  const name = `${prefix}-${digest.slice(0, 16)}.${extension}`;
  await writeFile(join(directory, name), bytes, { flag: "wx" });
  return { path: `tailscale/${name}`, sha256: digest, bytes: bytes.length };
}

export async function emitNativeAssets({
  here,
  repositoryRoot,
  source,
  compiler,
  output,
  wasm,
  wasmSha256,
  pins,
  requireHash,
}) {
  await requireHash(
    join(here, "native-http.mjs"),
    pins.nativeBridge.files[1].sha256,
  );
  await requireHash(join(source, "LICENSE"), pins.source.licenseSha256);
  await requireHash(join(compiler, "LICENSE"), pins.compiler.licenseSha256);
  const rootLicense = pins.publicTrust.moduleFiles.find(
    (file) => file.path === "LICENSE",
  );
  if (rootLicense?.sha256 !== pins.compiler.licenseSha256)
    throw new Error(
      "The roots license needs a separately preserved distribution notice.",
    );
  const thirdParty = await readFile(join(source, "licenses/tailscale.md"));
  if (hash(thirdParty) !== pins.composition.thirdPartySha256)
    throw new Error("Upstream third-party notice report changed.");
  const raw = await readFile(wasm);
  if (hash(raw) !== wasmSha256)
    throw new Error("Compiled native WASM changed before distribution.");
  const shim = await readFile(join(compiler, "lib/wasm/wasm_exec.js"));
  if (hash(shim) !== pins.composition.runtimeSha256)
    throw new Error(
      "Native runtime shim does not match the selected compiler.",
    );
  const bridge = await bridgeBundle(here, repositoryRoot, pins);
  const minify = await nativeMinifier(repositoryRoot, pins);
  const runtime = await minify(shim, pins.composition.runtimeMinifiedSha256);
  const nativeHTTP = await minify(bridge.bytes, pins.composition.bridgeSha256);
  const compressed = await compressNativeWasm({ raw, wasmSha256, output });
  const directory = join(output, "tailscale");
  await mkdir(directory);
  const assets = {
    wasm: await ownedAsset(directory, "main", "wasm.gz", compressed),
    runtime: await ownedAsset(directory, "go-runtime", "js", runtime),
    nativeHTTP: await ownedAsset(directory, "native-http", "js", nativeHTTP),
  };
  const notice = Buffer.concat([
    Buffer.from("Tailscale source (BSD-3-Clause)\n\n"),
    await readFile(join(source, "LICENSE")),
    Buffer.from("\n\nGo runtime and Go x509roots/fallback (BSD-3-Clause)\n\n"),
    await readFile(join(compiler, "LICENSE")),
    Buffer.from("\n\nZod4 runtime (MIT)\n\n"),
    bridge.license,
  ]);
  await writeFile(join(directory, "LICENSE.txt"), notice, { flag: "wx" });
  await writeFile(join(directory, "OPEN-SOURCE-LICENSES.md"), thirdParty, {
    flag: "wx",
  });
  const result = {
    sourceCommit: pins.source.commit,
    compilerCommit: pins.compiler.commit,
    publicRootsVersion: pins.publicTrust.version,
    rawWasm: { sha256: hash(raw), bytes: raw.length },
    buildTools: {
      minifier: pins.composition.terser,
      compressor: pins.composition.compressor,
    },
    assets,
    upstreamNotices: {
      path: "tailscale/OPEN-SOURCE-LICENSES.md",
      sha256: hash(thirdParty),
      bytes: thirdParty.length,
    },
    license: {
      path: "tailscale/LICENSE.txt",
      sha256: hash(notice),
      bytes: notice.length,
    },
    qualification:
      "Owned native runtime assets; original-node/capability/route configuration and PWA activation remain required.",
  };
  await writeFile(
    join(output, "native-artifacts.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx" },
  );
  return result;
}
