/**
 * The activity log's rail entries: the first page of events, newest first,
 * then "Load n more" — the same paging as every other listing subtree. The
 * log is read only once the row is opened (the shell mounts a `Tree` only
 * while its section is expanded), and the page's `/` search narrows these
 * rows as it narrows the page's, because both read one listing
 * (`sections/activity/activity-listing.ts`).
 */

import type { ActivityEvent } from "@opensesame/app-core/lib/activity-log.js";
import type { TreeProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { useLocation } from "react-router";
import { TreeRow } from "../../components/RailRows.js";
import { nextPageCount } from "../../lib/listing-page.js";
import {
  activityHref,
  activityIdFromPath,
  filterActivity,
  showMoreActivity,
} from "../../sections/activity/activity-listing.js";
import {
  useActivityEvents,
  useActivityListing,
} from "../../sections/activity/use-activity.js";

function railTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function EventLeaf({
  event,
  current,
}: {
  event: ActivityEvent;
  current: string;
}) {
  const href = activityHref(event.id);
  const selected = current === href;
  return (
    <TreeRow
      child
      level={2}
      to={href}
      label={event.summary}
      selected={selected}
      isActive={selected}
    >
      <span className="railtree__name">{event.summary}</span>
      <span className="railtree__count">{railTime(event.occurredAt)}</span>
    </TreeRow>
  );
}

function emptyNote(
  tomb: string | null,
  events: ActivityEvent[] | null,
  query: string,
): string {
  if (!tomb) return "Locked";
  if (events === null) return "Reading activity…";
  return query ? "No matching activity" : "No activity yet";
}

export function ActivityTree(_props: TreeProps) {
  const { pathname } = useLocation();
  const { tomb, events } = useActivityEvents();
  const { query, limit } = useActivityListing(tomb);
  const matches = filterActivity(events ?? [], query);
  const more = nextPageCount(matches.length, limit);
  const openId = activityIdFromPath(pathname);
  return (
    <div className="railtree__kids" id="activity-tree">
      {matches.slice(0, limit).map((event) => (
        <EventLeaf
          key={event.id}
          event={event}
          current={openId === event.id ? activityHref(event.id) : ""}
        />
      ))}
      {more > 0 ? (
        <TreeRow
          to="/activity#activity-more"
          child
          level={2}
          onToggle={() => showMoreActivity(tomb)}
        >
          {`Load ${more} more`}
        </TreeRow>
      ) : null}
      {matches.length === 0 ? (
        <output className="railtree__note">
          {emptyNote(tomb, events, query)}
        </output>
      ) : null}
    </div>
  );
}
