/**
 * Guard: the static PWA must not import restored Host / Identity / daemon
 * packages (restore stacked on #865; PWA contract from #861).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const pagesRoot = fileURLToPath(new URL("..", import.meta.url));
const forbiddenPackages = [
  "@opensesame/control-plane",
  "@opensesame/identity-worker",
  "@opensesame/database",
  "@opensesame/device-auth",
  "@opensesame/api-client",
  "@opensesame/webhooks",
];

function mentionsImport(text, id) {
  const patterns = [
    `from "${id}"`,
    `from '${id}'`,
    `from \`${id}\``,
    `import("${id}")`,
    `import('${id}')`,
    `import(\`${id}\`)`,
    `require("${id}")`,
    `require('${id}')`,
  ];
  return patterns.some((p) => text.includes(p));
}

const sourceExt = /\.(tsx?|mts|cts|jsx?|mjs|cjs)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith("dist-")) {
      continue;
    }
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (sourceExt.test(name)) out.push(path);
  }
  return out;
}

describe("pages stays backend-free", () => {
  it("package.json does not depend on Host/Identity/daemon packages", () => {
    const pkg = JSON.parse(readFileSync(join(pagesRoot, "package.json"), "utf8"));
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    };
    for (const id of forbiddenPackages) {
      assert.equal(deps[id], undefined, `pages must not depend on ${id}`);
    }
  });

  it("source does not import restored backend packages", () => {
    const offenders = [];
    for (const dir of ["src", "scripts", "server"]) {
      const root = join(pagesRoot, dir);
      try {
        statSync(root);
      } catch {
        continue;
      }
      for (const file of walk(root)) {
        const text = readFileSync(file, "utf8");
        const rel = relative(pagesRoot, file);
        for (const id of forbiddenPackages) {
          if (mentionsImport(text, id)) offenders.push(`${rel}: import ${id}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `forbidden backend imports:\n${offenders.join("\n")}`,
    );
  });

  it("apps/pages/api stays absent", () => {
    let present = false;
    try {
      present = statSync(join(pagesRoot, "api")).isDirectory();
    } catch {
      present = false;
    }
    assert.equal(present, false, "apps/pages/api/ must remain deleted");
  });
});
