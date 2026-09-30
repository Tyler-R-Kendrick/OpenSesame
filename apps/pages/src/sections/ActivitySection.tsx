/**
 * Activity — durable app event log at `/activity`.
 *
 * A paged listing like every other: the first page of events, `/` to
 * search, "Load n more" for the next page. A row opens that event's
 * details. The rail's subtree reads the same listing
 * (`activity/activity-listing.ts`), so both show the same rows.
 */

import type { ActivityEvent } from "@opensesame/app-core/lib/activity-log.js";
import { useEffect, useMemo, useRef } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { IconKey } from "../components/IconKey.js";
import { IconPlus, IconRefresh, IconX } from "../components/Icons.js";
import {
  SlashSearchField,
  SlashSearchKey,
  useListingSearch,
} from "../components/SlashSearch.js";
import { useHashTarget } from "../lib/hash-target.js";
import { nextPageCount } from "../lib/listing-page.js";
import { ActivityDetail } from "./activity/ActivityDetail.js";
import {
  activityHref,
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
import "./activity/activity.css";
import "./identity.css";
import "./settings.css";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function EventRow({
  event,
  open,
}: {
  event: ActivityEvent;
  open: boolean;
}) {
  return (
    <li className="identity-row" id={activityRowId(event.id)}>
      <Link
        className="identity-row__main"
        to={activityHref(event.id)}
        aria-current={open ? "page" : undefined}
      >
        <div className="identity-row__id">
          <h3>{event.summary}</h3>
          <p className="hint">
            {event.category} · {event.type} · {formatWhen(event.occurredAt)}
          </p>
        </div>
      </Link>
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
 * it; leaving the page drops it. A deep link to an event past the shown
 * page grows the page to it, and one the search hides clears the search.
 * An old `#activity-…` link is the same event: the caller redirects to it.
 */
function useActivitySearch(
  tomb: string | null,
  matches: readonly ActivityEvent[],
  events: readonly ActivityEvent[] | null,
) {
  const search = useListingSearch();
  const { hash } = useLocation();
  const { eventId } = useParams();
  const hashId = activityIdFromHash(hash);
  const openId = eventId ?? hashId;
  useEffect(() => {
    setActivityQuery(tomb, search.query ?? "");
  }, [tomb, search.query]);
  useEffect(() => () => setActivityQuery(tomb, ""), [tomb]);
  // Once per arriving link: a search typed afterwards may hide the row the
  // address still names, and that must narrow the list, not close the prompt.
  const landed = useRef<string | null>(null);
  useEffect(() => {
    if (!openId || landed.current === openId) return;
    const index = matches.findIndex((event) => event.id === openId);
    if (index >= 0) {
      landed.current = openId;
      revealActivity(tomb, index);
    } else if (events?.some((event) => event.id === openId)) search.close();
  }, [openId, tomb, matches, events, search.close]);
  return {
    search,
    openId,
    redirect: hashId && !eventId ? activityHref(hashId) : null,
  };
}

function LoadMore({ tomb, more }: { tomb: string | null; more: number }) {
  if (more <= 0) return null;
  const label = `Load ${more} more`;
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label={label}
      title={label}
      onClick={() => showMoreActivity(tomb)}
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
  const { search, openId, redirect } = useActivitySearch(tomb, matches, events);
  useHashTarget();

  if (redirect) return <Navigate to={redirect} replace />;
  if (!tomb) return <LockedActivity />;

  const empty = (events ?? []).length === 0;
  const opened = events?.find((event) => event.id === openId) ?? null;
  return (
    <div className="section__inner">
      <div className="section__head">
        <h1>Activity</h1>
      </div>
      <div
        className="activity-log"
        data-pane={openId && events ? "detail" : "list"}
      >
        <div className="activity-log__list">
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
                      <EventRow
                        key={event.id}
                        event={event}
                        open={event.id === openId}
                      />
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
        {openId && events ? (
          <div className="activity-log__detail">
            <ActivityDetail event={opened} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
