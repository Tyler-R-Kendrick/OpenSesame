import { LISTING_PAGE_SIZE } from "../../lib/listing-page.js";

/**
 * Shared page size for the Connections nav catalog and the Connected listing:
 * the one every paged listing uses (`lib/listing-page.ts`).
 */
export const CONNECTIONS_PAGE_SIZE = LISTING_PAGE_SIZE;

export { nextPageCount } from "../../lib/listing-page.js";
