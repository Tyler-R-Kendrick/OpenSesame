import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleDeclarations } from "./declarations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Workspace packages expose TypeScript sources. Bundle those sources so an
// installed CLI needs neither tsx nor the workspace's development dependencies.
await build({
  entryPoints: {
    bin: join(root, "src/bin.ts"),
    index: join(root, "src/index.ts"),
  },
  outdir: output,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
execFileSync(
  process.execPath,
  [
    join(root, "node_modules/typescript/bin/tsc"),
    "-p",
    join(root, "tsconfig.build.json"),
  ],
  { cwd: root, stdio: "inherit" },
);
await bundleDeclarations(root);
await chmod(join(output, "bin.js"), 0o755);
await cp(join(root, "src/parity-assets"), join(output, "parity-assets"), {
  recursive: true,
});
if (process.argv.includes("--native")) {
  const target = process.env.CARGO_TARGET_DIR;
  if (!target)
    throw new Error(
      "Release packaging requires CARGO_TARGET_DIR with a built native release companion.",
    );
  const name = process.platform === "win32" ? "opensesame.exe" : "opensesame";
  const source = join(target, "release", name);
  // Read before copying: a missing companion must fail the release build.
  if ((await readFile(source)).length === 0)
    throw new Error("Native companion is empty.");
  const destination = join(
    output,
    "native",
    `${process.platform}-${process.arch}`,
  );
  await mkdir(destination, { recursive: true });
  await cp(source, join(destination, name));
  await chmod(join(destination, name), 0o755);
}
