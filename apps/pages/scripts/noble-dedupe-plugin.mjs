/**
 * One copy of `@noble/curves` and `@noble/hashes` in the Pages bundle.
 *
 * `age-encryption@0.3.1` depends on `@noble/curves@2.4.0` and
 * `@noble/hashes@2.4.0`, and on `@noble/post-quantum@0.5.4` — which pins
 * `@noble/curves@2.0.1` and `@noble/hashes@2.0.1` exactly. pnpm honours the
 * pin, so every chunk that carries age (the SOPS worker and the chunk the
 * age-key code lands in) shipped both 2.x lines side by side: the same
 * Weierstrass, Montgomery, modular-arithmetic, SHA-2 and SHA-3 code twice.
 *
 * This resolves post-quantum's own `@noble/curves/*` and `@noble/hashes/*`
 * imports from `age-encryption`'s dependency tree instead, so they meet the
 * 2.4.0 copy age already ships. It is scoped to that one importer, and it
 * falls back to the pinned copy unless the target is the same major line.
 * Checked when it landed (ADR 0140 plan step 9): every named import
 * post-quantum makes exists in 2.4.0, and ML-KEM-512/768/1024, ML-DSA-44/65/87,
 * SLH-DSA-SHA2/SHAKE-128f and the X25519 hybrids (X-Wing, the kitchen-sink
 * ML-KEM-768+X25519 age uses) produce byte-identical keys, ciphertexts,
 * shared secrets and signatures from fixed seeds under both; an age hybrid
 * identity round-trips.
 *
 * `generateBundle` refuses a build in which a second 2.x copy of either
 * package reappears, so the saving cannot quietly regress.
 */

import { fileURLToPath } from "node:url";

const NOBLE = /^@noble\/(curves|hashes)\//;
const POST_QUANTUM = /[\\/]@noble\+post-quantum@[^\\/]+[\\/]/;
const SAME_MAJOR = /[\\/]@noble\+(curves|hashes)@2\./;
const COPY = /[\\/]@noble\+(curves|hashes)@(\d+\.\d+\.\d+)[\\/]/;
const ANCHOR = fileURLToPath(new URL("../src/main.tsx", import.meta.url));

/** Every `@noble/{curves,hashes}` version a set of module ids carries. */
export function nobleCopies(moduleIds) {
  const seen = new Map();
  for (const id of moduleIds) {
    const match = COPY.exec(id);
    if (!match) continue;
    const [, name, version] = match;
    if (!seen.has(name)) seen.set(name, new Set());
    seen.get(name).add(version);
  }
  return seen;
}

export function nobleDedupe() {
  let age = null;
  return {
    name: "opensesame:noble-dedupe",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !NOBLE.test(source) || !POST_QUANTUM.test(importer)) {
        return null;
      }
      age ??= await this.resolve("age-encryption", ANCHOR, {
        ...options,
        skipSelf: true,
      });
      if (!age) return null;
      const shared = await this.resolve(source, age.id, {
        ...options,
        skipSelf: true,
      });
      return shared && SAME_MAJOR.test(shared.id) ? shared : null;
    },
    generateBundle(_options, bundle) {
      const ids = Object.values(bundle).flatMap((chunk) =>
        chunk.type === "chunk" ? Object.keys(chunk.modules) : [],
      );
      for (const [name, versions] of nobleCopies(ids)) {
        const twos = [...versions].filter((v) => v.startsWith("2."));
        if (twos.length > 1) {
          this.error(
            `@noble/${name} is bundled twice (${twos.join(", ")}): scripts/noble-dedupe-plugin.mjs no longer folds post-quantum's copy into age-encryption's`,
          );
        }
      }
    },
  };
}
