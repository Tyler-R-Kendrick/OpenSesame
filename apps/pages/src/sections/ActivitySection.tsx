/**
 * Activity — durable app event log at `/activity`.
 *
 * A paged listing like every other: the first page of events, `/` to
 * search, "Load n more" for the next page. The rail's subtree reads the same
 * listing (`activity/activity-listing.ts`), so both show the same rows.
 */

import type { ActivityEvent } from "@opensesame/app-core/lib/activity-log.js";
import { useEffect, useMemo, useRef, useTransition } from "react";
import { useLocation } from "react-router";
import { IconKey } from "../components/IconKey.js";
import { IconPlus, IconRefresh, IconX } from "../components/Icons.js";
import {
  SlashSearchField,
  SlashSearchKey,
  useListingSearch,
} from "../components/SlashSearch.js";
import { useHashTarget } from "../lib/hash-target.js";
import { nextPageCount } from "../lib/listing-page.js";
import {
  activityIdFromHash,
  activityRowId,
  filterActivity,
  revealActivity,
  setActivityQuery,
  showMoreActivity,
} from "./activity/activity-listing.js";
import {
  useActivityEvents,
  useActivityListing,
} from "./activity/use-activity.js";
import "./identity.css";
import "./settings.css";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function EventRow({ event }: { event: ActivityEvent }) {
  return (
    <li className="identity-row" id={activityRowId(event.id)}>
      <div className="identity-row__main">
        <div className="identity-row__id">
          <h3>{event.summary}</h3>
          <p className="hint">
            {event.category} · {event.type} · {formatWhen(event.occurredAt)}
          </p>
        </div>
      </div>
    </li>
  );
}

function LockedActivity() {
  return (
    <div className="section__inner">
      <div className="section__head">
        <h1>Activity</h1>
      </div>
      <section className="panel" aria-labelledby="activity-log">
        <div className="panel__body">
          <div className="empty">
            <h3>Unlock a vault to read the activity log</h3>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * The page's `/` search is the listing's query, so the rail narrows with
 * it; leaving the page drops it. A deep link to a row past the shown page
 * grows the page to it, and one the search hides clears the search.
 */
function useActivitySearch(
  tomb: string | null,
  matches: readonly ActivityEvent[],
  events: readonly ActivityEvent[] | null,
) {
  const search = useListingSearch();
  const { hash } = useLocation();
  useEffect(() => {
    setActivityQuery(tomb, search.query ?? "");
  }, [tomb, search.query]);
  useEffect(() => () => setActivityQuery(tomb, ""), [tomb]);
  // Once per arriving link: a search typed afterwards may hide the row the
  // address still names, and that must narrow the list, not close the prompt.
  const landed = useRef<string | null>(null);
  useEffect(() => {
    const id = activityIdFromHash(hash);
    if (!id || landed.current === hash) return;
    const index = matches.findIndex((event) => event.id === id);
    if (index >= 0) {
      landed.current = hash;
      revealActivity(tomb, index);
    } else if (events?.some((event) => event.id === id)) search.close();
  }, [hash, tomb, matches, events, search.close]);
  return search;
}

function LoadMore({ tomb, more }: { tomb: string | null; more: number }) {
  const [pending, startTransition] = useTransition();
  if (more <= 0) return null;
  const label = pending ? "Loading activity" : `Load ${more} more`;
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      disabled={pending}
      aria-label={label}
      title={label}
      onClick={() => {
        if (pending) return;
        startTransition(() => showMoreActivity(tomb));
      }}
    >
      <IconPlus size={16} />
    </button>
  );
}

export function ActivitySection() {
  const { tomb, events, busy, refresh } = useActivityEvents();
  const { query, limit } = useActivityListing(tomb);
  const matches = useMemo(
    () => filterActivity(events ?? [], query),
    [events, query],
  );
  const search = useActivitySearch(tomb, matches, events);
  useHashTarget();

  if (!tomb) return <LockedActivity />;

  const empty = (events ?? []).length === 0;
  return (
    <div className="section__inner">
      <div className="section__head">
        <h1>Activity</h1>
      </div>
      <section className="panel" aria-labelledby="activity-log">
        <div className="panel__head">
          <div>
            <h2 id="activity-log">Log</h2>
          </div>
          <fieldset className="vtree__keys" aria-label="Activity commands">
            <SlashSearchKey onOpen={search.open} label="Search activity" />
            <IconKey
              label="Refresh activity"
              small
              disabled={busy}
              onClick={() => void refresh()}
            >
              <IconRefresh size={15} />
            </IconKey>
          </fieldset>
        </div>
        <div className="panel__body">
          {empty ? (
            <div className="empty">
              <h3>No activity yet</h3>
            </div>
          ) : matches.length === 0 ? (
            <div className="empty">
              <h3>No matching activity</h3>
              <IconKey label="Clear search" small onClick={search.close}>
                <IconX size={16} />
              </IconKey>
            </div>
          ) : (
            <>
              <ul className="identity-rows">
                {matches.slice(0, limit).map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </ul>
              <LoadMore
                tomb={tomb}
                more={nextPageCount(matches.length, limit)}
              />
            </>
          )}
        </div>
        {search.query !== null ? (
          <SlashSearchField
            query={search.query}
            onChange={search.setQuery}
            onClose={search.close}
            inputRef={search.inputRef}
            label="Search the activity log"
          />
        ) : null}
      </section>
    </div>
  );
}
