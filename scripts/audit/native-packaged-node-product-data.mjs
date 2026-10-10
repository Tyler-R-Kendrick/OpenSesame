// Actual extracted source-export packages, fixed release bytes and exact original config.
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
const core = join(process.cwd(), "packages/app-core");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function linkOriginalTarget(target, destination) {
  const kind = await stat(target);
  if (!kind.isDirectory() && !kind.isFile())
    throw new Error("Original dependency kind unavailable.");
  await symlink(
    target,
    destination,
    kind.isDirectory()
      ? process.platform === "win32"
        ? "junction"
        : "dir"
      : "file",
  );
}
export async function linkDependencies(from, to, overrides = {}) {
  await mkdir(to, { mode: 0o700 });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith("@")) {
      await mkdir(join(to, entry.name), { mode: 0o700 });
      for (const name of await readdir(join(from, entry.name))) {
        const key = `${entry.name}/${name}`;
        const target = overrides[key] ?? (await realpath(join(from, key)));
        await linkOriginalTarget(target, join(to, key));
      }
    } else {
      await linkOriginalTarget(
        await realpath(join(from, entry.name)),
        join(to, entry.name),
      );
    }
  }
}
export async function installExactRelease(provenance, source, created) {
  const destination = join(
    core,
    "src/node/native-companion",
    `${process.platform}-${process.arch}`,
  );
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination, { mode: 0o700 });
  created.push(destination);
  const fixedRoot = dirname(provenance.installed.path);
  const manifest = JSON.parse(
    await readFile(join(fixedRoot, "manifest.json"), "utf8"),
  );
  const bytes = await readFile(provenance.installed.path);
  if (
    provenance.source !== source() ||
    provenance.profile !== "default-release" ||
    provenance.workerCloseVerified !== true ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.sha256 !== sha(bytes) ||
    manifest.bytes !== bytes.length ||
    provenance.installed.sha256 !== manifest.sha256 ||
    /[/\\]/.test(manifest.executable)
  )
    throw new Error("Actual default release provenance unavailable.");
  await copyFile(
    provenance.installed.path,
    join(destination, manifest.executable),
  );
  await copyFile(
    join(fixedRoot, "manifest.json"),
    join(destination, "manifest.json"),
  );
  if (
    sha(await readFile(join(destination, manifest.executable))) !==
    manifest.sha256
  )
    throw new Error("Fixed package copy changed.");
  return manifest;
}
export async function preparePackedTests(packedCore, groups) {
  const config = "vitest.config.ts";
  const original = await readFile(join(core, config));
  const configured = join(packedCore.root, config);
  try {
    if (sha(await readFile(configured)) !== sha(original))
      throw new Error("Packed original Vitest config changed.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await copyFile(join(core, config), configured);
  }
  // The original exact config resolves this sibling explicitly; same signed product dependency.
  await symlink(
    await realpath(join(core, "../os-domain")),
    join(dirname(packedCore.root), "os-domain"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const group of groups)
    for (const file of group.files) {
      if (
        sha(await readFile(join(core, file))) !==
        sha(await readFile(join(packedCore.root, file)))
      )
        throw new Error("Packed original control source changed.");
    }
  const setup = "src/test-setup.ts";
  if (
    sha(await readFile(join(core, setup))) !==
    sha(await readFile(join(packedCore.root, setup)))
  )
    throw new Error("Packed original test setup changed.");
  return {
    config: configured,
    configSha256: sha(original),
    setupSha256: sha(await readFile(join(core, setup))),
  };
}
