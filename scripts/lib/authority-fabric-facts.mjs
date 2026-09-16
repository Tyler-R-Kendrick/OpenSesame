/**
 * Fact collection for the authority-fabric gate (work item TEST-STACK).
 *
 * Everything that reads the tree or shells out lives here, so the verdict logic
 * in authority-fabric.mjs stays a pure function of what was observed. Facts are
 * gathered per run, never cached and never hardcoded: modules in this programme
 * are appearing and being wired while the gate is being written, and a snapshot
 * baked into the harness would report a state that no longer exists.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Members of the Cargo workspace. A crate outside this list is not compiled. */
export function workspaceMembers(root) {
  const manifest = readFileSync(join(root, "Cargo.toml"), "utf8");
  const block = /^members\s*=\s*\[([^\]]*)\]/m.exec(manifest);
  if (block === null) return [];
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Resolve a crate by package name across the workspace member directories, and
 * report whether its declared lib target actually exists. A Cargo.toml pointing
 * at a missing src/lib.rs is the shape a half-landed crate takes.
 */
export function crateFacts(root, crateNames, members) {
  const facts = {};
  const byPackageName = new Map();
  for (const member of members) {
    const manifestPath = join(root, member, "Cargo.toml");
    if (!existsSync(manifestPath)) continue;
    const manifest = readFileSync(manifestPath, "utf8");
    const name = /^name\s*=\s*"([^"]+)"/m.exec(manifest);
    if (name !== null) byPackageName.set(name[1], { member, manifest });
  }
  for (const crate of crateNames) {
    const found = byPackageName.get(crate);
    if (found === undefined) {
      facts[crate] = { inWorkspace: false, libPath: null, libExists: false };
      continue;
    }
    const libPath = libTargetPath(found.manifest);
    facts[crate] = {
      inWorkspace: true,
      member: found.member,
      libPath,
      libExists: existsSync(join(root, found.member, libPath)),
    };
  }
  return facts;
}

function libTargetPath(manifest) {
  const lib = /\[lib\][\s\S]*?(?=\n\[|$)/.exec(manifest);
  if (lib !== null) {
    const path = /^path\s*=\s*"([^"]+)"/m.exec(lib[0]);
    if (path !== null) return path[1];
  }
  return "src/lib.rs";
}

/**
 * Remove Rust comments, including nested block comments, before looking for a
 * `mod` declaration. A commented-out declaration is how a half-landed module is
 * parked — `pub mod budget;` sat inside a `/* WIP ... *\u002f` block while the
 * files underneath it were complete — and a regex that cannot see the comment
 * reports that module as wired when nothing in it compiles.
 */
export function stripRustComments(source) {
  let out = "";
  let depth = 0;
  let index = 0;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (depth > 0) {
      if (pair === "/*") {
        depth += 1;
        index += 2;
      } else if (pair === "*/") {
        depth -= 1;
        index += 2;
      } else {
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      continue;
    }
    if (pair === "/*") {
      depth = 1;
      index += 2;
      continue;
    }
    if (pair === "//") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

/**
 * Is a module reachable from its crate root? A file on disk that no `mod`
 * declaration names is not compiled, so nothing in it is tested however many
 * `#[test]` functions it holds. `#[cfg(test)] mod` counts, since that is exactly
 * how the adversarial suites are attached. A `::` path is walked level by level,
 * so "budget is wired but limits is not" is reported as what it is.
 */
export function moduleFacts(root, crates, targets) {
  const facts = {};
  const sources = new Map();
  const read = (path) => {
    if (!sources.has(path)) {
      sources.set(
        path,
        existsSync(path) ? stripRustComments(readFileSync(path, "utf8")) : null,
      );
    }
    return sources.get(path);
  };
  for (const { crate, module } of targets) {
    const crateFact = crates[crate];
    const key = `${crate}:${module}`;
    if (crateFact === undefined || crateFact.libExists !== true) {
      facts[key] = false;
      continue;
    }
    const crateRoot = join(root, crateFact.member, crateFact.libPath);
    facts[key] = declaresChain(read, crateRoot, module.split("::"));
  }
  return facts;
}

function declaresChain(read, parentPath, chain) {
  let current = parentPath;
  for (const level of chain) {
    const source = read(current);
    if (source === null) return false;
    const declared = new RegExp(
      `^\\s*(pub(\\s*\\([^)]*\\))?\\s+)?mod\\s+${level}\\s*;`,
      "m",
    ).test(source);
    if (!declared) return false;
    const directory = dirname(current);
    const inline = join(directory, `${level}.rs`);
    current = existsSync(inline) ? inline : join(directory, level, "mod.rs");
  }
  return true;
}

/**
 * Enumerate the tests a crate actually has, by asking Cargo rather than by
 * grepping for `#[test]`. On failure it reports what Cargo said, so a crate that
 * does not compile is distinguishable from one that has no tests — the verdict
 * logic treats neither as an empty set.
 */
export function enumerateCargoTests(root, crate) {
  const result = spawnSync(
    "cargo",
    [
      "+1.88.0",
      "test",
      "-p",
      crate,
      "--lib",
      "--",
      "--list",
      "--format",
      "terse",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const printed = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    return {
      tests: null,
      error:
        printed === ""
          ? `cargo exited ${String(result.status)} with no output`
          : cargoDiagnostics(printed),
    };
  }
  return {
    tests: result.stdout
      .split("\n")
      .map((line) => /^(\S+):\s+test$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => match[1]),
    error: null,
  };
}

/**
 * Reduce a failed cargo run to the lines that say what broke.
 *
 * The last few lines of a rustc failure are usually the tail of a code snippet
 * (`   |`), which names neither the error nor the crate. That mattered in
 * practice: a dependency of `opensesame-authz` failed to compile and the gate
 * reported `test-enumeration-failed` with a bare `|` as its evidence, so the
 * scenario looked like a harness defect rather than a broken dependency. Keeping
 * the `error...` headlines — including cargo's own `could not compile <crate>` —
 * makes a dependency's breakage legible as such.
 */
export function cargoDiagnostics(printed) {
  const lines = printed.split("\n");
  const headlines = lines.filter((line) =>
    /^\s*(error(\[E\d+\])?:|error: could not compile)/.test(line),
  );
  if (headlines.length === 0) return lines.slice(-6).join("\n");
  return [...new Set(headlines.map((line) => line.trim()))]
    .slice(0, 6)
    .join("\n");
}

/** Workspace package name to directory, for the vitest-backed scenarios. */
export function packageFacts(root) {
  const facts = {};
  for (const group of ["apps", "packages"]) {
    const groupPath = join(root, group);
    if (!existsSync(groupPath)) continue;
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(groupPath, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const { name } = JSON.parse(readFileSync(manifestPath, "utf8"));
        // A directory whose manifest names no package is not one a scenario can
        // address, so it is left out rather than recorded under a placeholder.
        if (name !== undefined) facts[name] = { dir: `${group}/${entry.name}` };
      } catch {
        // An unparseable package.json is not a workspace package.
      }
    }
  }
  return facts;
}

/**
 * Capability ids declared in the registry, read as text. This answers only
 * "does an authority capability exist yet"; the surface contract itself is left
 * to the registry's own parity test, which already enforces it for every id.
 */
export function capabilityIds(root) {
  const source = join(root, "packages", "capability-registry", "src");
  if (!existsSync(source)) return null;
  const ids = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    const text = readFileSync(join(source, entry.name), "utf8");
    for (const match of text.matchAll(/^\s*id:\s*"([^"]+)"/gm)) {
      ids.push(match[1]);
    }
  }
  return ids;
}

/**
 * Modules under `directory` whose names put them in the authority family, and so
 * must be classified by the INV-GA-10 inventory as either the share ledger or
 * explicitly not it.
 *
 * The signal is the filename, deliberately: it cannot tell a real rival ledger
 * from a different concern, which is why the answer is "classify this", not "this
 * is a violation". `local-grant-store.ts` (application OIDC grants) matches and
 * is legitimately not the ledger — the inventory records that, and a module in
 * neither list is what blocks.
 */
export const LEDGER_NAME_SIGNAL = /(grant|share|authority|rbac|permission)/i;

export function ledgerCandidates(root, directory) {
  const path = join(root, directory);
  if (!existsSync(path)) return null;
  return readdirSync(path, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".fixture.ts") &&
        !entry.name.endsWith(".d.ts") &&
        LEDGER_NAME_SIGNAL.test(entry.name),
    )
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}

/** The declared inventory behind INV-GA-10, or null when it has not been written. */
export function ledgerInventory(root, relativePath) {
  const path = join(root, relativePath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed.declared) ? parsed : null;
  } catch {
    return null;
  }
}

/** Presence of the exact paths the scenarios name. */
export function fileFacts(root, paths) {
  const facts = {};
  for (const path of paths) facts[path] = existsSync(join(root, path));
  return facts;
}
