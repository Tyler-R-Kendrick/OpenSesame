// Splits a verify script's work across CI legs: `TUTORIALS_SHARD=k/n` and
// `EXPERIENCE_SHARD=k/n`, 1-based, unset meaning the one whole shard.
//
// The tutorial library is split by id, not by place in the list: it grows once
// a vault holds items, and a place would move a tutorial between legs. The leg
// that holds shard 1 also runs the passes that are not a tutorial (Escape, the
// move, the gates). A fixed list of walks is split in turn (`every`).

/** @param {string | undefined} value `k/n`, 1-based; unset is the one whole shard */
export function parseShard(value, name = "TUTORIALS_SHARD") {
  if (value === undefined || value === "") return { index: 1, count: 1 };
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(`${name} must be k/n with 1 <= k <= n, got "${value}"`);
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

/** The kth of n in turn: the item at `position` in a fixed list. */
export const inTurn = (position, { index, count }) =>
  position % count === index - 1;
