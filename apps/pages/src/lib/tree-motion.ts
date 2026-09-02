/**
 * Shared cursor arithmetic for the rail and the vault listing.
 * Counts, pages and H/M/L are the same motion in both trees.
 */

export function stepIndex(at: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (!Number.isFinite(delta)) return delta < 0 ? 0 : length - 1;
  const from = at < 0 ? 0 : at;
  return Math.min(Math.max(from + delta, 0), length - 1);
}

export function pageSteps(
  scroller: HTMLElement | null,
  half: boolean,
  fallback = half ? 5 : 10,
): number {
  const height = scroller?.clientHeight ?? 0;
  const row = rowHeight(scroller);
  if (height <= 0 || row <= 0) return fallback;
  const visible = Math.max(1, Math.floor(height / row));
  return half ? Math.max(1, Math.floor(visible / 2)) : Math.max(1, visible - 1);
}

export function viewportIndex(
  scroller: HTMLElement | null,
  rows: Array<HTMLElement | null | undefined>,
  where: "high" | "mid" | "low",
): number {
  if (rows.length === 0) return -1;
  const height = scroller?.clientHeight ?? 0;
  if (!scroller || height <= 0) {
    if (where === "high") return 0;
    if (where === "low") return rows.length - 1;
    return Math.floor((rows.length - 1) / 2);
  }
  const top = scroller.scrollTop;
  const bottom = top + height;
  const visible: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowBottom > top && rowTop < bottom) visible.push(i);
  }
  if (visible.length === 0) {
    if (where === "high") return 0;
    if (where === "low") return rows.length - 1;
    return Math.floor((rows.length - 1) / 2);
  }
  if (where === "high") return visible[0] ?? 0;
  if (where === "low") return visible[visible.length - 1] ?? rows.length - 1;
  return visible[Math.floor((visible.length - 1) / 2)] ?? 0;
}

function rowHeight(scroller: HTMLElement | null): number {
  const row = scroller?.querySelector<HTMLElement>(
    "[role='treeitem'], .railtree__row",
  );
  return row?.offsetHeight ?? 0;
}
