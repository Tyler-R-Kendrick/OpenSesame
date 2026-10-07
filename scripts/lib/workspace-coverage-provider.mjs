import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import native from "@vitest/coverage-v8";
import { V8CoverageProvider } from "@vitest/coverage-v8/dist/provider.js";
import { z } from "zod";
import {
  coverageIncludePatterns,
  runtimeSourceInventory,
} from "./ts-coverage-scope.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const groups = ["apps", "packages", "examples", "tests", "tools"];
const manifestSchema = z.object({ name: z.string().min(1) });
const includesSchema = z.array(z.string().min(1)).min(1);
export const PINNED_COVERAGE_VERSION = "4.1.11";

export function sourceDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function workspaceCoverageInventory(root = workspace) {
  const tracked = new Set(
    execFileSync("git", ["ls-files", "--cached", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8_000_000,
    }).split("\0"),
  );
  const inventory = new Map();
  const patterns = [];
  const owners = new Set();
  for (const group of groups) {
    for (const entry of readdirSync(join(root, group), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const owner = `${group}/${entry.name}`;
      if (!tracked.has(`${owner}/package.json`)) continue;
      const directory = join(root, owner);
      manifestSchema.parse(
        JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
      );
      owners.add(realpathSync(directory));
      patterns.push(
        ...coverageIncludePatterns(owner).map((pattern) =>
          join(directory, pattern).replaceAll("\\", "/"),
        ),
      );
      for (const path of runtimeSourceInventory(directory, owner)) {
        if (!tracked.has(relative(root, path).replaceAll("\\", "/"))) continue;
        const canonical = realpathSync(path).replaceAll("\\", "/");
        inventory.set(canonical, sourceDigest(path));
      }
    }
  }
  return { inventory, patterns, owners };
}

export async function fillOwnerInventory(provider, testedFiles, walk) {
  if (provider.ownerFillActive)
    throw new Error("Concurrent owner coverage fill is unsupported.");
  const workspaceIncludes = provider.options.include;
  provider.ownerFillActive = true;
  provider.options.include = provider.ownIncludes;
  provider.globCache.clear();
  try {
    return await walk(testedFiles);
  } finally {
    provider.options.include = workspaceIncludes;
    provider.globCache.clear();
    provider.ownerFillActive = false;
  }
}

export class SparseWorkspaceCoverageProvider extends V8CoverageProvider {
  initialize(context) {
    if (
      this.version !== PINNED_COVERAGE_VERSION ||
      context.version !== PINNED_COVERAGE_VERSION
    ) {
      throw new Error("Unsupported native V8 coverage interface version.");
    }
    super.initialize(context);
    includesSchema.parse(this.options.include);
    this.ownIncludes = this.options.include;
    const catalog = workspaceCoverageInventory();
    if (!catalog.owners.has(realpathSync(context.config.root))) {
      throw new Error("Coverage owner is outside the tracked workspace.");
    }
    this.inventory = catalog.inventory;
    this.options.include = catalog.patterns;
    this.options.allowExternal = true;
    this.globCache.clear();
  }

  isIncluded(filename, root) {
    const canonical = resolve(filename).replaceAll("\\", "/");
    return this.inventory.has(canonical) && super.isIncluded(filename, root);
  }

  getUntestedFiles(testedFiles) {
    return fillOwnerInventory(this, testedFiles, (files) =>
      super.getUntestedFiles(files),
    );
  }

  async generateCoverage(context) {
    const map = await super.generateCoverage(context);
    for (const path of map.files()) {
      const expected = this.inventory.get(resolve(path).replaceAll("\\", "/"));
      if (expected === undefined || sourceDigest(path) !== expected) {
        throw new Error(
          "Runtime source changed during native coverage capture.",
        );
      }
      // Retain every native counter/map unchanged; bind merging to these source bytes.
      map.fileCoverageFor(path).data.sourceSha256 = expected;
    }
    return map;
  }
}

export default {
  startCoverage: native.startCoverage,
  takeCoverage: native.takeCoverage,
  stopCoverage: native.stopCoverage,
  getProvider: async () => new SparseWorkspaceCoverageProvider(),
};
