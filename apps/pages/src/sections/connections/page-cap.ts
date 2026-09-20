/**
 * Shared page size for the Connections nav catalog and the Connected listing.
 * The page starts at this cap; "load n more" advances by the same step.
 */
export const CONNECTIONS_PAGE_SIZE = 12;

/** How many additional rows the next "load n more" should reveal. */
export function nextPageCount(
  total: number,
  shown: number,
  pageSize = CONNECTIONS_PAGE_SIZE,
): number {
  return Math.min(pageSize, Math.max(0, total - shown));
}
