/**
 * One activity event, opened from its row. The list stays beside it; on a
 * phone this pane is the screen, and the back key returns to the log.
 */

import type { ActivityEvent } from "@opensesame/app-core/lib/activity-log.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { Link } from "react-router";
import { FieldRow } from "../../components/FieldRow.js";
import { IconChevronLeft } from "../../components/Icons.js";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function metadataText(value: BoundaryValue): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return null;
  return JSON.stringify(value);
}

function ActivityFacts({ event }: { event: ActivityEvent }) {
  const target = [event.targetType, event.targetId].filter(Boolean).join(" ");
  const metadata = Object.entries(event.metadata).flatMap(([key, value]) => {
    const text = metadataText(value);
    return text === null ? [] : [{ key, text }];
  });
  return (
    <>
      <FieldRow label="When">{formatWhen(event.occurredAt)}</FieldRow>
      <FieldRow label="Category">{event.category}</FieldRow>
      <FieldRow label="Type">{event.type}</FieldRow>
      <FieldRow label="Outcome">{event.outcome}</FieldRow>
      {target ? <FieldRow label="Target">{target}</FieldRow> : null}
      {metadata.map((row) => (
        <FieldRow key={row.key} label={row.key}>
          {row.text}
        </FieldRow>
      ))}
    </>
  );
}

export function ActivityDetail({ event }: { event: ActivityEvent | null }) {
  return (
    <div className="detail">
      <div className="detail__head">
        <Link
          data-pane-close=""
          className="icon-btn detail__backbtn"
          aria-label="Back to the log"
          title="Back to the log"
          to="/activity"
        >
          <IconChevronLeft size={17} />
        </Link>
        <div className="detail__heading">
          <h2>{event ? event.summary : "That event is not in this log"}</h2>
        </div>
      </div>
      {event ? <ActivityFacts event={event} /> : null}
    </div>
  );
}
