/**
 * One chunk per built-in item-type pack (ADR 0165).
 *
 * A pack's definition is ~2 KB, far under `experimentalMinChunkSize`, so
 * Rollup folds each into whatever chunk it may — five of the eighteen landed in
 * `main` and `expiry`, which every page load fetches. Naming each module here
 * keeps it a leaf of its own: reached only through the loader's dynamic
 * `import()`, fetched when a person switches the type on.
 */

const toPosix = (path) => path.replace(/\\/g, "/");

const PACK =
  /\/packages\/vault-item-types\/src\/packs\/([a-z0-9-]+)\.generated\.[jt]s$/;

export function itemTypePackChunk(id) {
  const match = PACK.exec(toPosix(id));
  return match ? `item-type-pack-${match[1]}` : undefined;
}
