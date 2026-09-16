/**
 * Discover wallet domain packages/suites via filesystem globs.
 * Honest: missing targets are reported; never invented as passing.
 */

import { existsSync, globSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {{
 *   id: string,
 *   kind: "os-domain-wallet" | "package",
 *   packageName: string,
 *   packageDir: string,
 *   present: boolean,
 *   matchedPaths: string[],
 *   testCommand: string[] | null,
 *   missingReason: string | null,
 * }} DomainTarget
 */

/**
 * @param {string} root
 * @returns {DomainTarget[]}
 */
export function discoverDomainTargets(root) {
  return [
    discoverOsDomainWallet(root),
    discoverPackage(root, {
      id: "wallet-budget",
      packageName: "@opensesame/wallet-budget",
      packageDir: "packages/wallet-budget",
    }),
    discoverPackage(root, {
      id: "wallet-policy",
      packageName: "@opensesame/wallet-policy",
      packageDir: "packages/wallet-policy",
    }),
  ];
}

/**
 * @param {string} root
 * @returns {DomainTarget}
 */
function discoverOsDomainWallet(root) {
  const packageDir = "packages/os-domain";
  const packageJson = join(root, packageDir, "package.json");

  if (!existsSync(packageJson)) {
    return missing(
      "os-domain-wallet",
      "os-domain-wallet",
      "@opensesame/os-domain",
      packageDir,
      ["packages/os-domain/package.json not found"],
    );
  }

  const sourceHits = globRel(
    root,
    packageDir,
    "src/wallet/**/*.{ts,tsx,mts,cts,js,mjs}",
  );
  const testHits = [
    ...globRel(root, packageDir, "src/wallet/**/*.test.{ts,tsx,mts,cts}"),
    ...globRel(root, packageDir, "src/__tests__/wallet*/**/*.{ts,tsx}"),
    ...globRel(root, packageDir, "src/__tests__/*wallet*.{ts,tsx}"),
  ];

  if (sourceHits.length === 0) {
    return {
      id: "os-domain-wallet",
      kind: "os-domain-wallet",
      packageName: "@opensesame/os-domain",
      packageDir,
      present: false,
      matchedPaths: [],
      testCommand: null,
      missingReason:
        "packages/os-domain/src/wallet/ has no source files yet (DOM swarm not landed)",
    };
  }

  const filterArgs = ["vitest", "run", "src/wallet"];
  for (const hit of testHits) {
    if (!hit.includes("src/wallet/") && hit.includes("src/__tests__/")) {
      // Pass the concrete matched file/dir, never the whole __tests__ tree.
      const rel = hit.replace(/^packages\/os-domain\//, "");
      if (!filterArgs.includes(rel)) filterArgs.push(rel);
    }
  }

  return {
    id: "os-domain-wallet",
    kind: "os-domain-wallet",
    packageName: "@opensesame/os-domain",
    packageDir,
    present: true,
    matchedPaths: unique([...sourceHits, ...testHits]),
    testCommand: [
      "pnpm",
      "--filter",
      "@opensesame/os-domain",
      "exec",
      ...filterArgs,
    ],
    missingReason: null,
  };
}

/**
 * @param {string} root
 * @param {{ id: string, packageName: string, packageDir: string }} spec
 * @returns {DomainTarget}
 */
function discoverPackage(root, spec) {
  const packageJson = join(root, spec.packageDir, "package.json");
  if (!existsSync(packageJson)) {
    return missing(spec.id, "package", spec.packageName, spec.packageDir, [
      `${spec.packageDir}/package.json not found (package not created yet)`,
    ]);
  }

  const hits = globRel(
    root,
    spec.packageDir,
    "**/*.{ts,tsx,mts,cts,js,mjs,json}",
  );
  return {
    id: spec.id,
    kind: "package",
    packageName: spec.packageName,
    packageDir: spec.packageDir,
    present: true,
    matchedPaths: hits.slice(0, 40),
    testCommand: ["pnpm", "--filter", spec.packageName, "test"],
    missingReason: null,
  };
}

/**
 * @param {string} id
 * @param {"os-domain-wallet" | "package"} kind
 * @param {string} packageName
 * @param {string} packageDir
 * @param {string[]} reasons
 * @returns {DomainTarget}
 */
function missing(id, kind, packageName, packageDir, reasons) {
  return {
    id,
    kind,
    packageName,
    packageDir,
    present: false,
    matchedPaths: [],
    testCommand: null,
    missingReason: reasons.join("; "),
  };
}

/**
 * @param {string} root
 * @param {string} packageDir
 * @param {string} pattern
 * @returns {string[]}
 */
function globRel(root, packageDir, pattern) {
  const cwd = join(root, packageDir);
  try {
    return globSync(pattern, {
      cwd,
      exclude: (/** @type {string} */ name) =>
        name === "node_modules" ||
        name === ".turbo" ||
        name === "dist" ||
        name === "coverage",
    }).map((rel) => join(packageDir, rel).replaceAll("\\", "/"));
  } catch {
    return [];
  }
}

/** @param {string[]} paths */
function unique(paths) {
  return [...new Set(paths)];
}
