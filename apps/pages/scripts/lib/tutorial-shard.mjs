// Splits the tutorial library across CI legs.
//
// `TUTORIALS_SHARD=k/n` walks the tutorials whose id hashes to k of n, by the
// id and not its place in the list: the library grows once a vault holds items,
// and a place would move a tutorial between legs. The leg that holds shard 1
// also runs the passes that are not a tutorial (Escape, the move, the gates).

/** @param {string | undefined} value `k/n`, 1-based; unset is the one whole shard */
export function parseShard(value) {
  if (value === undefined || value === "") return { index: 1, count: 1 };
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(
      `TUTORIALS_SHARD must be k/n with 1 <= k <= n, got "${value}"`,
    );
  }
  return { index: Number(match[1]), count: Number(match[2]) };
}

/** FNV-1a over the id: stable across runs and Node versions. */
function hash(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

export const inShard = (id, { index, count }) => hash(id) % count === index - 1;

export const isFirstShard = ({ index }) => index === 1;
