/** Source-runner dependencies must be usable immediately after install. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CLIENT = "@opensesame/cli";

function consumesClient(candidate) {
  return [
    candidate.dependencies,
    candidate.devDependencies,
    candidate.optionalDependencies,
    candidate.peerDependencies,
  ].some((dependencies) => Object.hasOwn(dependencies ?? {}, CLIENT));
}

function completeClientContract(manifest) {
  return (
    manifest.exports?.["."]?.types === "./dist/index.d.ts" &&
    manifest.exports?.["."]?.default === "./dist/index.js" &&
    manifest.bin?.["opensesame-id"] === "./dist/bin.js" &&
    manifest.bin?.["opensesame-identity"] === "./dist/bin.js" &&
    manifest.scripts?.["test:installed"] ===
      "node scripts/build.mjs && node scripts/test-installed.mjs"
  );
}

function clientEntryFailures(manifest, manifests) {
  const failures = [];
  // This executable ships emitted JS; it must never become a source-suite dependency.
  const consumers = manifests.filter(consumesClient);
  if (consumers.length)
    failures.push(
      `${CLIENT}: source consumers ${consumers.map((entry) => entry.name).join(", ")}`,
    );
  if (!completeClientContract(manifest))
    failures.push(
      `${CLIENT}: emitted executable/library contract is incomplete`,
    );
  return failures;
}

export function sourceEntryFailures(manifests) {
  return manifests.flatMap((manifest) => {
    if (!/"\.\/dist\//u.test(JSON.stringify(manifest.exports ?? {}))) return [];
    if (manifest.name !== CLIENT)
      return [`${manifest.name}: source entry exports through dist/`];
    return clientEntryFailures(manifest, manifests);
  });
}

export function workspaceManifests(root) {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(resolve(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(root, group, entry.name, "package.json"))
      .filter((file) => existsSync(file))
      .map((file) => JSON.parse(readFileSync(file, "utf8"))),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const manifests = workspaceManifests(process.cwd());
  const failures = sourceEntryFailures(manifests);
  for (const failure of failures) console.error(failure);
  console.log(
    `MTLS_TESTS passed=${manifests.length - failures.length} failed=${failures.length}`,
  );
  if (failures.length) process.exitCode = 1;
}
