/** Native SDK, device and FFI checks follow their actual Rust input graph. */
import { loadCrateNodes, repoRootFromHere } from "./ci-affected-graph.mjs";

const FILES = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain",
  "rust-toolchain.toml",
  ".github/workflows/ci.yml",
  ".github/workflows/native-admission.yml",
  "scripts/lib/ci-changed-areas.mjs",
  "scripts/lib/ci-native-area.mjs",
  "scripts/lib/ci-native-area.test.mjs",
]);
const SEEDS = [
  "opensesame-authenticator-core",
  "opensesame-human-vault",
  "opensesame-sealed-store",
  "opensesame-cli",
];
const HUMAN_PROTOCOL_DIRS = [
  "packages/app-core/src/lib/retired-credentials/",
  "packages/app-core/src/lib/credential-canaries/",
  "packages/app-core/src/lib/credential-observation/",
];

export function nativeCrateDirs(nodes = loadCrateNodes(repoRootFromHere())) {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const seen = new Set();
  const queue = [...SEEDS];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    const node = byName.get(name);
    if (!node) throw new Error(`Native input graph has no ${name}`);
    seen.add(name);
    for (const dep of node.deps) if (byName.has(dep)) queue.push(dep);
  }
  return [...seen].map((name) => byName.get(name).dir);
}

let inputDirs;
export function isNativeInput(path) {
  if (FILES.has(path)) return true;
  // Windows compiles the full CLI. New or renamed crate dependencies must not
  // escape that platform gate before the input graph learns their identity.
  if (path === "crates" || path.startsWith("crates/")) return true;
  if (path === "apps/cli" || path.startsWith("apps/cli/")) return true;
  if (!path.includes("/") && path.startsWith("Cargo.")) return true;
  if (path === "apps/android" || path.startsWith("apps/android/")) return true;
  if (path.startsWith(".cargo/")) return true;
  if (HUMAN_PROTOCOL_DIRS.some((directory) => path.startsWith(directory)))
    return true;
  try {
    inputDirs ??= nativeCrateDirs();
    return inputDirs.some((dir) => path === dir || path.startsWith(`${dir}/`));
  } catch {
    // Failure to resolve an authority dependency must never skip native checks.
    return true;
  }
}
