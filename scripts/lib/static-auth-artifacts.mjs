import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { Script } from "node:vm";
import { z } from "zod";

const distribution = "apps/pages/public/static-auth";
export const manifestPath = `${distribution}/manifest.json`;
export const compatibilityPath = "apps/pages/public/auth.js";
const versionSchema = z
  .string()
  .max(32)
  .regex(/^\d+\.\d+\.\d+$/);
const sriSchema = z.string().regex(/^sha384-[A-Za-z0-9+/]{64}$/);
const manifestSchema = z
  .object({
    version: versionSchema,
    packageVersion: versionSchema,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sri: sriSchema,
    artifacts: z
      .array(
        z
          .object({
            path: z.union([
              z.literal(compatibilityPath),
              z
                .string()
                .max(200)
                .regex(
                  /^apps\/pages\/public\/static-auth\/\d+\.\d+\.\d+\/opensesame-auth\.min\.js$/,
                ),
            ]),
            sri: sriSchema,
          })
          .strict(),
      )
      .min(2)
      .max(64),
  })
  .strict();
export const integrity = (bytes) =>
  `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

export function artifactPaths(version) {
  versionSchema.parse(version);
  return [
    `${distribution}/${version}/opensesame-auth.min.js`,
    compatibilityPath,
  ];
}

export function artifactOverride(paths) {
  return {
    include: paths,
    linter: { enabled: false },
    formatter: { enabled: false },
    organizeImports: { enabled: false },
  };
}

/** A reviewed release cannot be removed or rewritten by updating its local hash. */
export function assertImmutableArtifacts(previous, current) {
  for (const artifact of manifestSchema.parse(previous).artifacts) {
    assert.equal(
      current.artifacts.find((entry) => entry.path === artifact.path)?.sri,
      artifact.sri,
      `Published artifact changed or removed: ${artifact.path}`,
    );
  }
}

/** Preserve every frozen artifact while selecting a new current release. */
export function releaseManifest(version, sourceCommit, artifacts, previous) {
  const current = manifestSchema.parse({
    version,
    packageVersion: version,
    sourceCommit,
    sri: artifacts[0].sri,
    artifacts: [
      ...artifacts,
      ...(previous?.artifacts ?? []).filter(
        (old) => !artifacts.some((entry) => entry.path === old.path),
      ),
    ],
  });
  if (previous) {
    assertImmutableArtifacts(previous, current);
    if (previous.version === version) {
      assert.equal(previous.sri, current.sri, "Release manifest SRI mismatch");
      assert.deepEqual(previous.artifacts, current.artifacts);
      return previous;
    }
  }
  return current;
}

function readRegular(root, path, maximum = 1024 * 1024) {
  const file = resolve(root, path);
  assert.equal(realpathSync(file), file, `Symlinked artifact: ${path}`);
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && stat.size <= maximum, `Invalid artifact: ${path}`);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    readFileSync(file),
  );
}

function inventory(root, allowed, directory = distribution) {
  const absolute = join(root, directory);
  assert.equal(
    realpathSync(absolute),
    absolute,
    "Symlinked artifact directory",
  );
  const directories = new Set([...allowed].map(dirname));
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    assert.ok(!entry.isSymbolicLink(), `Symlinked artifact: ${path}`);
    if (entry.isDirectory()) {
      assert.ok(
        directories.has(path),
        `Undeclared artifact directory: ${path}`,
      );
      inventory(root, allowed, path);
    } else {
      assert.ok(
        entry.isFile() && allowed.has(path),
        `Undeclared artifact: ${path}`,
      );
    }
  }
}

/** Exact generated files get byte/source validation; authored files retain Biome. */
export function validateStaticAuth(rootPath) {
  const root = realpathSync(rootPath);
  const manifest = manifestSchema.parse(
    JSON.parse(readRegular(root, manifestPath, 16384)),
  );
  const required = artifactPaths(manifest.version);
  assert.equal(manifest.packageVersion, manifest.version);
  const paths = manifest.artifacts.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length, "Duplicate artifact");
  assert.ok(
    required.every((path) => paths.includes(path)),
    "Missing current artifact",
  );
  const packageJson = JSON.parse(
    readRegular(root, "packages/static-auth/package.json"),
  );
  assert.equal(
    packageJson.version,
    manifest.version,
    "SDK package version drift",
  );
  const allowed = new Set([
    manifestPath,
    ...paths,
    ...paths.map((path) => `${path}.sha384`),
  ]);
  inventory(root, allowed);
  const config = JSON.parse(readRegular(root, "biome.json"));
  for (const tool of ["linter", "formatter", "organizeImports"])
    assert.equal(
      config[tool]?.enabled,
      true,
      "Authored-code checks must stay enabled",
    );
  const exceptions = (config.overrides ?? []).filter(
    (entry) =>
      entry.linter?.enabled === false ||
      entry.formatter?.enabled === false ||
      entry.organizeImports?.enabled === false,
  );
  assert.deepEqual(
    exceptions,
    [artifactOverride(paths)],
    "Generated-code exception drift",
  );
  assert.ok(
    !(config.files?.ignore ?? []).some(
      (path) => path.includes("static-auth") || path.includes("public/auth.js"),
    ),
    "Artifacts must use exact overrides, not ignored directories",
  );
  for (const entry of manifest.artifacts) {
    for (let path = entry.path; path !== "."; path = dirname(path)) {
      assert.ok(
        !(config.files?.ignore ?? []).some((pattern) =>
          matchesGlob(path, pattern),
        ),
        "Artifacts must use exact overrides, not ignored directories",
      );
    }
    const bytes = readRegular(root, entry.path);
    assert.equal(
      entry.sri,
      integrity(bytes),
      `Artifact hash mismatch: ${entry.path}`,
    );
    assert.equal(
      readRegular(root, `${entry.path}.sha384`, 128),
      `${entry.sri}\n`,
    );
    new Script(bytes, { filename: relative(root, resolve(root, entry.path)) });
  }
  assert.equal(
    manifest.sri,
    manifest.artifacts.find((entry) => entry.path === required[0]).sri,
  );
  return manifest;
}
