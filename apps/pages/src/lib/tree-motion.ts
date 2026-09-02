/**
 * Shared cursor arithmetic for the rail and the vault listing.
 * Counts, pages and H/M/L are the same motion in both trees.
 */

export function stepIndex(at: number, delta: number, length: number): number {
  const last = length - 1;
  if (last < 0) return -1;
  return Math.min(last, Math.max(0, Math.max(0, at) + delta));
}

export function pageSteps(
  scroller: HTMLElement | null,
  half: boolean,
  fallback = half ? 5 : 10,
): number {
  if (scroller === null) return fallback;
  const height = scroller.clientHeight;
  const row = rowHeight(scroller);
  if (height < 1 || row < 1) return fallback;
  const visible = Math.floor(height / row);
  return half ? Math.max(1, Math.floor(visible / 2)) : Math.max(1, visible - 1);
}

export function viewportIndex(
  scroller: HTMLElement | null,
  rows: Array<HTMLElement | null | undefined>,
  where: "high" | "mid" | "low",
): number {
  if (rows.length === 0) return -1;
  if (scroller === null || scroller.clientHeight < 1) {
    return wholeList(rows.length, where);
  }
  const top = scroller.scrollTop;
  const bottom = top + scroller.clientHeight;
  const visible: number[] = [];
  rows.forEach((row, i) => {
    if (row === null || row === undefined) return;
    const rowTop = row.offsetTop;
    if (rowTop + row.offsetHeight > top && rowTop < bottom) {
      visible.push(i);
    }
  });
  if (visible.length === 0) return wholeList(rows.length, where);
  if (where === "high") return visible[0];
  if (where === "low") return visible[visible.length - 1];
  return visible[Math.floor((visible.length - 1) / 2)];
}

function wholeList(length: number, where: "high" | "mid" | "low"): number {
  if (where === "high") return 0;
  if (where === "low") return length - 1;
  return Math.floor((length - 1) / 2);
}

function rowHeight(scroller: HTMLElement): number {
  const row = scroller.querySelector<HTMLElement>(
    "[role='treeitem'], .railtree__row",
  );
  if (row === null) return 0;
  return row.offsetHeight;
}
