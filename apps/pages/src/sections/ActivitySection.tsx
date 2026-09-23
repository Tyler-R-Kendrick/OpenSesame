/**
 * Activity — durable app event log at `/activity`.
 */

import {
  type ActivityEvent,
  listActivityEvents,
  subscribeActivity,
} from "@opensesame/app-core/lib/activity-log.js";
import { useCallback, useEffect, useState } from "react";
import { IconRefresh } from "../components/Icons.js";
import { useVault } from "../lib/vault/hooks.js";
import "./identity.css";
import "./settings.css";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function EventRow({ event }: { event: ActivityEvent }) {
  return (
    <li className="identity-row">
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

export function ActivitySection() {
  const { status, guest, tomb } = useVault();
  const unlocked = status === "unlocked" && !guest && Boolean(tomb);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!tomb || !unlocked) {
      setEvents([]);
      return;
    }
    setBusy(true);
    try {
      setEvents(await listActivityEvents(tomb));
    } catch {
      setEvents([]);
    } finally {
      setBusy(false);
    }
  }, [tomb, unlocked]);

  useEffect(() => {
    void refresh();
    return subscribeActivity(() => {
      void refresh();
    });
  }, [refresh]);

  if (!unlocked) {
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
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              disabled={busy}
              aria-label="Refresh activity"
              title="Refresh activity"
              onClick={() => void refresh()}
            >
              <IconRefresh size={15} />
            </button>
          </fieldset>
        </div>
        <div className="panel__body">
          {events.length === 0 ? (
            <div className="empty">
              <h3>No activity yet</h3>
            </div>
          ) : (
            <ul className="identity-rows">
              {events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
