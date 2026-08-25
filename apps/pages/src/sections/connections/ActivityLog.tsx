import { useEffect, useState } from "react";
import type { ConnectionEvent } from "../../lib/connections.js";
import { connectionEvents } from "../../lib/connections.js";
import { errorText, formatWhen } from "./shared.js";

export function ActivityLog({
  connectionId,
  limit,
}: {
  connectionId: string;
  limit?: number;
}) {
  const [events, setEvents] = useState<ConnectionEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    connectionEvents(connectionId)
      .then((next) => {
        if (!cancelled) setEvents(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  if (error)
    return <p className="note note--err conn-activity__err">{error}</p>;
  if (events === null) return <p className="hint conn-pad">Reading history…</p>;
  if (events.length === 0)
    return <p className="hint conn-pad">No events recorded.</p>;

  const visible = limit ? events.slice(0, limit) : events;
  return (
    <ol className="conn-activity">
      {visible.map((event) => (
        <li key={event.id}>
          <span className="conn-activity__kind">
            {event.kind.replace(/_/g, " ")}
          </span>
          <span className="conn-activity__at">{formatWhen(event.at)}</span>
          {event.detail ? (
            <span className="conn-activity__detail">{event.detail}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
