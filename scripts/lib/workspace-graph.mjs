/**
 * Workspace discovery -- turns both planes into one comparable component graph.
 *
 * A "component" here is what Robert C. Martin calls a package: the granule of
 * release. In this repo that is a pnpm workspace package or a Cargo crate, so
 * both are read from their own authoritative manifest and normalised into the
 * same shape for scripts/lib/martin-metrics.mjs to score.
 */
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * @typedef {object} Component
 * @property {string} name       manifest name
 * @property {string} dir        repo-relative directory
 * @property {"ts"|"rust"} plane
 * @property {string[]} deps     internal release dependencies (ADP/SDP graph)
 * @property {string[]} devDeps  internal dev-only dependencies
 */

const WORKSPACE_PROTOCOL = "workspace:";

/** @returns {Component[]} */
export function typescriptComponents(root) {
  const patterns = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
    .split("\n")
    .map((line) => /^\s*-\s*"?(?<glob>[^"\s]+)"?\s*$/.exec(line)?.groups?.glob)
    .filter((glob) => glob !== undefined);

  const manifests = new Set(
    patterns.flatMap((pattern) =>
      globSync(`${pattern}/package.json`, { cwd: root }),
    ),
  );

  const components = [];
  for (const manifestPath of [...manifests].sort()) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    // The workspace globs can match a manifest with no name (a private
    // scratch package); it is not a component, so skip it.
    if (manifest.name === undefined) continue;
    components.push({
      name: manifest.name,
      dir: dirname(manifestPath),
      plane: "ts",
      deps: internalDeps(manifest.dependencies, manifest.peerDependencies),
      devDeps: internalDeps(manifest.devDependencies),
    });
  }
  return components;
}

function internalDeps(...groups) {
  const names = new Set();
  for (const group of groups) {
    for (const [name, range] of Object.entries(group ?? {})) {
      if (String(range).startsWith(WORKSPACE_PROTOCOL)) names.add(name);
    }
  }
  return [...names].sort();
}

/** @returns {Component[]} */
export function rustComponents(root) {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--no-deps", "--format-version", "1", "--offline"],
      { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
    ),
  );
  const members = new Set(metadata.packages.map((pkg) => pkg.name));

  return metadata.packages
    .map((pkg) => {
      const byKind = { release: new Set(), dev: new Set() };
      for (const dep of pkg.dependencies) {
        // `cargo metadata` emits `path` only for in-workspace path
        // dependencies; a registry crate has no such key and is third-party,
        // outside the component graph.
        if (dep.path === undefined || !members.has(dep.name)) continue;
        if (dep.name === pkg.name) continue;
        byKind[dep.kind === "dev" ? "dev" : "release"].add(dep.name);
      }
      return {
        name: pkg.name,
        dir: relative(root, dirname(pkg.manifest_path)),
        plane: "rust",
        deps: [...byKind.release].sort(),
        devDeps: [...byKind.dev].sort(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Abstractness input: how much of a component's exported surface is a contract
 * (trait/interface/type) rather than an implementation.
 *
 * This is a syntactic count, not a type-checked one -- enough to place a
 * component on the main sequence, not precise enough to argue over decimals.
 * Reported as a heuristic wherever it is shown.
 */
export function abstractness(root, component) {
  const extensions = component.plane === "ts" ? ["ts", "tsx"] : ["rs"];
  const files = extensions.flatMap((extension) =>
    globSync(`${component.dir}/src/**/*.${extension}`, { cwd: root }),
  );

  let abstract = 0;
  let concrete = 0;
  for (const file of files) {
    if (/(\.test\.|\.spec\.|__tests__\/|\/tests\/)/.test(file)) continue;
    const source = readFileSync(join(root, file), "utf8");
    const counts =
      component.plane === "ts" ? tsSurface(source) : rustSurface(source);
    abstract += counts.abstract;
    concrete += counts.concrete;
  }
  const total = abstract + concrete;
  return { abstract, concrete, value: total === 0 ? 0 : abstract / total };
}

function tsSurface(source) {
  return {
    abstract: count(
      source,
      /^\s*export\s+(?:declare\s+)?(?:interface|type|abstract\s+class)\b/gm,
    ),
    concrete: count(
      source,
      /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:class|function|const|let|var|enum)\b/gm,
    ),
  };
}

function rustSurface(source) {
  return {
    abstract: count(source, /^\s*pub(?:\([^)]*\))?\s+trait\b/gm),
    concrete: count(
      source,
      /^\s*pub(?:\([^)]*\))?\s+(?:struct|enum|fn|async\s+fn)\b/gm,
    ),
  };
}

function count(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}
