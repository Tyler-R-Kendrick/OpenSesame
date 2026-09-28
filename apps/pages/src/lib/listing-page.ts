/**
 * The page size every paged listing and rail subtree starts at — the
 * connector catalog, Connected, the activity log. "Load n more" advances by
 * the same step, so a rail subtree and the page it mirrors stay in step.
 */
export const LISTING_PAGE_SIZE = 12;

/** How many additional rows the next "load n more" should reveal. */
export function nextPageCount(
  total: number,
  shown: number,
  pageSize = LISTING_PAGE_SIZE,
): number {
  return Math.min(pageSize, Math.max(0, total - shown));
}
