import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/;
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const metadataSchema = z.object({
  name: z.string(),
  version: z.string(),
  dependencies: z.record(z.string()).optional().default({}),
  optionalDependencies: z.record(z.string()).optional().default({}),
});
const findingSchema = z.object({
  ruleId: z.enum(["OA006", "OA008"]),
  package: z.object({ name: z.string() }),
  location: z.object({ file: z.literal("package.json"), jsonPath: z.string() }),
});

function readJson(path) {
  if (statSync(path).size > 65_536)
    throw new Error("Oversized package metadata");
  return JSON.parse(readFileSync(path, "utf8"));
}

function versionParts(value) {
  if (!exactVersion.test(value)) throw new Error("Unsupported version form");
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("Oversized version");
  return parts;
}

function meetsFloor(actual, floor) {
  const actualParts = versionParts(actual);
  const floorParts = versionParts(floor);
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] !== floorParts[index]) {
      return actualParts[index] > floorParts[index];
    }
  }
  return true;
}

function parseScope(overrides, finding) {
  const parsed = findingSchema.parse(finding);
  const prefix = "/pnpm/overrides/";
  if (!parsed.location.jsonPath.startsWith(prefix))
    throw new Error("Mismatched finding path");
  const pointer = parsed.location.jsonPath.slice(prefix.length);
  const key = pointer.replaceAll("~1", "/").replaceAll("~0", "~");
  if (key.replaceAll("~", "~0").replaceAll("/", "~1") !== pointer) {
    throw new Error("Malformed finding pointer");
  }
  const names = key.split(">");
  let parent;
  let child;
  let selector;
  if (key === "js-yaml@^3") {
    parent = "js-yaml";
    child = null;
    selector = "^3";
  } else if (key === "js-yaml@3.15.2>argparse") {
    parent = "js-yaml";
    child = "argparse";
    selector = "3.15.2";
  } else {
    if (names.length !== 2 || !names.every((name) => packageName.test(name))) {
      throw new Error("Unsupported override scope");
    }
    [parent, child] = names;
  }
  const correctedAttribution =
    child === "argparse" && parsed.package.name === "js-yaml";
  if (parsed.package.name !== (child ?? parent) && !correctedAttribution)
    throw new Error("Mismatched finding package");
  const target = z.string().parse(overrides[key]);
  versionParts(target);
  if (correctedAttribution) validateScannerAttribution(finding, target);
  return { key, parent, child, target, selector, correctedAttribution };
}

function validateScannerAttribution(finding, target) {
  const findingSchema = z.object({
    ruleId: z.literal("OA006"),
    severity: z.literal("medium"),
    message: z.literal(
      "Override fights an exact-pinned parent (effect not confirmed on disk)",
    ),
    details: z.literal(
      `js-yaml is overridden to "${target}", but its installed parent promptfoo@0.122.0 declares it as exact (dependencies: "5.2.2"). No installed copy confirms the override took; if the parent's exact pin wins resolution, npm/pnpm keep that version on disk and the override does nothing. Override the parent instead.`,
    ),
  });
  findingSchema.parse(finding);
}

function selectedParent(root, path, scope) {
  if (!scope.selector) return true;
  const parent = metadataSchema.parse(
    readJson(confinedPath(root, join(path, "package.json"))),
  );
  if (parent.name !== scope.parent)
    throw new Error("Mismatched selected parent");
  const parts = versionParts(parent.version);
  return scope.selector === "^3"
    ? parts[0] === 3
    : parent.version === scope.selector;
}

function confinedPath(root, path) {
  const physical = realpathSync(path);
  const rel = relative(root, physical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Package metadata escapes project");
  }
  return physical;
}

function findParents(root, parent) {
  const modules = join(root, "node_modules");
  const queue = [modules, join(modules, ".pnpm/node_modules")];
  const store = join(modules, ".pnpm");
  if (existsSync(store)) {
    const entries = readdirSync(store);
    if (entries.length > 4096) throw new Error("Oversized virtual store");
    queue.push(...entries.map((entry) => join(store, entry, "node_modules")));
  }
  const visited = new Set();
  const parents = [];
  for (let index = 0; index < queue.length; index += 1) {
    if (queue.length > 32_768)
      throw new Error("Oversized dependency traversal");
    if (!existsSync(queue[index])) continue;
    const directory = confinedPath(root, queue[index]);
    if (visited.has(directory)) continue;
    visited.add(directory);
    const candidate = join(directory, parent);
    if (existsSync(candidate)) parents.push(confinedPath(root, candidate));
    queue.push(...nestedModules(root, directory));
  }
  const unique = [...new Set(parents)];
  if (unique.length === 0) throw new Error("No installed scoped parent");
  return unique;
}

function nestedModules(root, directory) {
  const entries = readdirSync(directory);
  if (entries.length > 4096) throw new Error("Oversized dependency directory");
  const packages = entries.filter((entry) => !entry.startsWith("."));
  const roots = packages.flatMap((entry) => {
    const path = join(directory, entry);
    if (!entry.startsWith("@")) return [path];
    const scoped = readdirSync(confinedPath(root, path));
    if (scoped.length > 4096) throw new Error("Oversized package scope");
    return scoped.map((name) => join(path, name));
  });
  return roots.map((path) => join(path, "node_modules")).filter(existsSync);
}

function resolveChild(root, parentPath, child) {
  let cursor = parentPath;
  for (let depth = 0; depth < 128; depth += 1) {
    const candidate = join(cursor, "node_modules", child);
    if (basename(cursor) !== "node_modules" && !existsSync(candidate)) {
      try {
        if (lstatSync(candidate).isSymbolicLink())
          throw new Error("Dangling scoped child");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (basename(cursor) !== "node_modules" && existsSync(candidate)) {
      return confinedPath(root, candidate);
    }
    if (cursor === root) break;
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  throw new Error("Unresolved scoped child");
}

function inspectParent(root, path, scope) {
  const parent = metadataSchema.parse(
    readJson(confinedPath(root, join(path, "package.json"))),
  );
  if (parent.name !== scope.parent)
    throw new Error("Mismatched scoped parent metadata");
  versionParts(parent.version);
  if (!scope.child) {
    if (!meetsFloor(parent.version, scope.target))
      throw new Error("Selected package below floor");
    return { parentPath: path, parentVersion: parent.version };
  }
  const declarations = [parent.dependencies, parent.optionalDependencies]
    .map((dependencies) => dependencies[scope.child])
    .filter((declaration) => declaration !== undefined);
  if (declarations.length !== 1)
    throw new Error("Absent or ambiguous declared dependency");
  const childPath = resolveChild(root, path, scope.child);
  const child = metadataSchema.parse(
    readJson(confinedPath(root, join(childPath, "package.json"))),
  );
  if (child.name !== scope.child || !meetsFloor(child.version, scope.target)) {
    throw new Error("Scoped child metadata mismatch or version below floor");
  }
  return {
    parentPath: path,
    parentVersion: parent.version,
    declaredChild: declarations[0],
    childPath,
    childVersion: child.version,
  };
}

/** Correct only the scanner's global interpretation of an exact scoped floor. */
export function validateScopedOverrideFinding(project, overrides, finding) {
  try {
    const root = realpathSync(project);
    const scope = parseScope(overrides, finding);
    const parents = findParents(root, scope.parent).filter((path) =>
      selectedParent(root, path, scope),
    );
    if (parents.length === 0) throw new Error("No installed selected parent");
    if (scope.correctedAttribution) {
      const reported = findParents(root, "promptfoo").some((path) => {
        const metadata = metadataSchema.parse(
          readJson(confinedPath(root, join(path, "package.json"))),
        );
        return (
          metadata.name === "promptfoo" &&
          metadata.version === "0.122.0" &&
          metadata.dependencies["js-yaml"] === "5.2.2"
        );
      });
      if (!reported) throw new Error("Unverified scanner attribution");
    }
    const resolutions = parents.map((path) => inspectParent(root, path, scope));
    return { qualified: true, ...scope, resolutions };
  } catch (error) {
    return {
      qualified: false,
      reason: z.instanceof(Error).parse(error).message,
    };
  }
}

export function inspectScopedFindings(project, findings) {
  const root = realpathSync(project);
  const manifest = z
    .object({ pnpm: z.object({ overrides: z.record(z.string()) }) })
    .parse(readJson(confinedPath(root, join(root, "package.json"))));
  return findings.map((finding, index) => ({
    index,
    ...validateScopedOverrideFinding(project, manifest.pnpm.overrides, finding),
  }));
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const project = z.string().parse(process.argv[2]);
  const report = z
    .object({ findings: z.array(z.unknown()) })
    .parse(readJson(process.argv[3]));
  process.stdout.write(
    `${JSON.stringify(inspectScopedFindings(project, report.findings))}\n`,
  );
}
