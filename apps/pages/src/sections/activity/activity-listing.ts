/**
 * The activity log as a paged, searchable listing — one state the page and
 * its rail subtree both read, so the rail lists exactly the rows the page
 * draws: the same `/` search narrows both, and "Load n more" in either
 * advances both.
 *
 * The state belongs to one tomb. A lock, a vault switch or a guest session
 * reads the defaults (no query, one page) rather than another vault's search.
 */

import type { ActivityEvent } from "@opensesame/app-core/lib/activity-log.js";
import { LISTING_PAGE_SIZE } from "../../lib/listing-page.js";

export type ActivityListing = Readonly<{
  tomb: string | null;
  /** The `/` search, trimmed and lowercased; empty lists everything. */
  query: string;
  /** How many matching rows are shown. */
  limit: number;
}>;

const ROW_PREFIX = "activity-";

/** The id a page row carries, which a rail entry's hash names. */
export function activityRowId(eventId: string): string {
  return `${ROW_PREFIX}${eventId}`;
}

/** Where a rail entry takes you: the row on the page. */
export function activityHref(eventId: string): string {
  return `/activity#${ROW_PREFIX}${encodeURIComponent(eventId)}`;
}

/** The event a `#activity-…` hash names, if it names one. */
export function activityIdFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith(ROW_PREFIX)) return null;
  try {
    return decodeURIComponent(raw.slice(ROW_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

export function normalizeActivityQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/** What a search matches: the words the page shows for the row. */
function haystack(event: ActivityEvent): string {
  return [
    event.summary,
    event.category,
    event.type,
    event.outcome,
    event.targetType ?? "",
    event.targetId ?? "",
  ]
    .join(" ")
    .toLocaleLowerCase();
}

/** Events matching the query, newest first as the log stores them. */
export function filterActivity(
  events: readonly ActivityEvent[],
  query: string,
): ActivityEvent[] {
  const needle = normalizeActivityQuery(query);
  if (!needle) return [...events];
  return events.filter((event) => haystack(event).includes(needle));
}

const DEFAULTS: ActivityListing = {
  tomb: null,
  query: "",
  limit: LISTING_PAGE_SIZE,
};

let state: ActivityListing = DEFAULTS;
const listeners = new Set<() => void>();

function publish(next: ActivityListing): void {
  if (
    next.tomb === state.tomb &&
    next.query === state.query &&
    next.limit === state.limit
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeActivityListing(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One defaults object per tomb, so a store snapshot is stable. */
let fallback: ActivityListing = DEFAULTS;

/** The listing for this tomb; another tomb's state reads as the defaults. */
export function activityListing(tomb: string | null): ActivityListing {
  if (tomb !== null && state.tomb === tomb) return state;
  if (fallback.tomb !== tomb) fallback = { ...DEFAULTS, tomb };
  return fallback;
}

/** A new search starts again at one page. */
export function setActivityQuery(tomb: string | null, query: string): void {
  const normalized = normalizeActivityQuery(query);
  if (activityListing(tomb).query === normalized) return;
  publish({ tomb, query: normalized, limit: LISTING_PAGE_SIZE });
}

/** Reveal the next page. */
export function showMoreActivity(tomb: string | null): void {
  const current = activityListing(tomb);
  publish({ ...current, limit: current.limit + LISTING_PAGE_SIZE });
}

/**
 * Grow the listing, a page at a time, until the row at `index` is shown —
 * a deep link to a row past the first page still lands on it.
 */
export function revealActivity(tomb: string | null, index: number): void {
  const current = activityListing(tomb);
  if (index < current.limit) return;
  const pages = Math.floor(index / LISTING_PAGE_SIZE) + 1;
  publish({ ...current, limit: pages * LISTING_PAGE_SIZE });
}

/** Test seam: forget the listing between cases. */
export function resetActivityListing(): void {
  publish(DEFAULTS);
}
