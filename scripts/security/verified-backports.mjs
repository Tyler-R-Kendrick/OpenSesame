import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "../lib/json-boundary.mjs";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(
  new URL("../../node_modules/.pnpm/node_modules/", import.meta.url),
);
const { parse } = require("yaml");
const evidence = JSON.parse(
  readFileSync(new URL("./dependency-backports.json", import.meta.url), "utf8"),
);
const supported = {
  braces: ["3.0.3", "GHSA-vfj7-8cjw-p6xm"],
  "node-forge": ["1.4.0", "GHSA-86w9-cpqp-85rv"],
};
const sha = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

function verifyDependencyEdge(dependencyName, entry, name, patchedVersion) {
  const reference = isString(entry) ? entry : entry.version;
  if (dependencyName === name && reference !== patchedVersion) {
    throw new Error("Unpatched dependency edge");
  }
  if (
    isString(reference) &&
    reference.includes(`${name}@`) &&
    reference !== `${name}@${patchedVersion}`
  ) {
    throw new Error("Unpatched aliased dependency edge");
  }
}

function verifyConsumerEdges(lock, name, patchedVersion) {
  const consumers = [
    ...Object.values(lock.snapshots ?? {}),
    ...Object.values(lock.importers ?? {}),
  ];
  for (const consumer of consumers) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      for (const [dependencyName, entry] of Object.entries(
        consumer[field] ?? {},
      )) {
        verifyDependencyEdge(dependencyName, entry, name, patchedVersion);
      }
    }
  }
}

function verifyPatchBinding(root, key, proof, manifest, lock) {
  const patch = lock.patchedDependencies?.[key];
  if (
    !patch?.hash ||
    patch.path !== proof.patch ||
    manifest.pnpm?.patchedDependencies?.[key] !== proof.patch
  )
    throw new Error("Missing exact patched dependency binding");
  if (sha(resolve(root, proof.patch)) !== proof.patchSha256)
    throw new Error("Backport patch hash mismatch");
  return patch;
}

function verifyInstalledSources(root, name, version, patch, proof) {
  const installed = realpathSync(
    resolve(root, "node_modules/.pnpm/node_modules", name),
  );
  if (
    !installed.endsWith(
      `${name}@${version}_patch_hash=${patch.hash}/node_modules/${name}`,
    )
  )
    throw new Error("Installed package is not the lockfile backport");
  for (const [file, hash] of Object.entries(proof.sources)) {
    if (sha(resolve(installed, file)) !== hash)
      throw new Error("Installed backport source hash mismatch");
  }
}

/** Exact checked-in repairs only; absent, stale or raw dependencies fail closed. */
export function verifyBackportSource(
  name,
  version,
  advisory,
  root = repository,
) {
  if (supported[name]?.[0] !== version || supported[name]?.[1] !== advisory)
    return false;
  const proof = evidence[name];
  const key = `${name}@${version}`;
  const manifest = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  const lock = parse(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"));
  const patch = verifyPatchBinding(root, key, proof, manifest, lock);
  const patchedVersion = `${version}(patch_hash=${patch.hash})`;
  if (!lock.snapshots?.[`${name}@${patchedVersion}`])
    throw new Error("Missing patched snapshot");
  verifyConsumerEdges(lock, name, patchedVersion);
  verifyInstalledSources(root, name, version, patch, proof);
  return true;
}

export function verifiedFinding(finding, root = repository) {
  return (
    finding.ecosystem === "npm" &&
    verifyBackportSource(finding.package, finding.version, finding.id, root)
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const findings = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const remaining = [];
  const remediated = [];
  try {
    for (const finding of findings)
      (verifiedFinding(finding) ? remediated : remaining).push(finding);
    if (remediated.length) {
      const regression = spawnSync(
        process.execPath,
        [
          "--test",
          resolve(repository, "scripts/security/dependency-backports.test.mjs"),
        ],
        { cwd: repository, encoding: "utf8", timeout: 30000 },
      );
      if (regression.status !== 0 || regression.error)
        throw new Error(
          `Backport attack regressions failed: ${regression.stdout} ${regression.stderr}`,
        );
    }
    for (const finding of remediated)
      console.log(
        `Source-verified remediation: ${finding.id} ${finding.package}@${finding.version}`,
      );
    if (remaining.length)
      throw new Error(
        `Unremediated vulnerabilities: ${JSON.stringify(remaining)}`,
      );
    console.log(
      `osv-scanner gate: CLEAN (${remediated.length} source-verified backports, no unremediated findings)`,
    );
  } catch (error) {
    console.error(`osv-scanner gate: FAIL (${error.message})`);
    process.exitCode = 1;
  }
}
