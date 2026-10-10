import type { TreeRow } from "@opensesame/vault-core";

/**
 * Group an open folder's items into one block. The guide is drawn on that
 * block, so it stays inside the subtree instead of running through the folder
 * row above or the sibling below.
 */
export function guideBlocks(
  rows: readonly TreeRow[],
): Array<TreeRow | TreeRow[]> {
  const blocks: Array<TreeRow | TreeRow[]> = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!row) break;
    if (row.type !== "item" || !row.child) {
      blocks.push(row);
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < rows.length) {
      const next = rows[index];
      if (!next || next.type !== "item" || !next.child) break;
      index += 1;
    }
    blocks.push(rows.slice(start, index));
  }
  return blocks;
}
