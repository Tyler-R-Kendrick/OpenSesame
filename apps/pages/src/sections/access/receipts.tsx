/**
 * Receipts — the Identity plane's trail of what an agent actually did.
 *
 * It is not the Host's, which is the whole reason it lives here rather than
 * inside the Sessions panel it renders beneath: gating it on a Host, as the
 * first cut of ADR 0090 did, hid an Identity-plane feature behind a plane it
 * never calls. Splitting it out also takes a hundred lines off the Access
 * screen, which the structural ratchet asks of anything that touches it.
 */

import { type JsonObject, isString } from "@opensesame/os-domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlert, IconClock, IconRefresh } from "../../components/Icons.js";
import {
  IdentityError,
  identityBase,
  identityJson,
} from "../../lib/identity.js";
import { formatTime } from "./format.js";

export type AuditEvent = {
  id: string;
  occurredAt: string;
  eventType: string;
  outcome: string;
  actorType?: string;
  clientId?: string;
  metadata?: JsonObject;
};

function isReceiptEvent(event: AuditEvent): boolean {
  if (
    event.eventType.startsWith("agent.") ||
    event.eventType.startsWith("connection.")
  ) {
    return true;
  }
  if (event.actorType === "agent") return true;
  const instance = event.metadata?.agentInstanceId;
  return isString(instance) && instance.length > 0;
}

/** One line of the trail: when, what, and how it came out. */
function ReceiptRow({ event }: { event: AuditEvent }) {
  return (
    <li>
      <span className="access-trail__when">
        <IconClock /> {formatTime(event.occurredAt)}
      </span>
      <span className="access-trail__type">{event.eventType}</span>
      <span className={`chip ${outcomeChip(event.outcome)}`}>
        {event.outcome}
      </span>
    </li>
  );
}

export function Receipts({
  online,
  sessionKey,
}: {
  online: boolean;
  sessionKey: string;
}) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A trail read for one principal must never land under another. */
  const run = useRef(0);
  const shownFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    const id = ++run.current;
    const superseded = () => run.current !== id;
    setBusy(true);
    setError(null);
    try {
      const body = await identityJson<{ events: AuditEvent[] }>(
        "/v1/audit/events?limit=50",
      );
      if (superseded()) return;
      setEvents(body.events.filter(isReceiptEvent));
    } catch (err) {
      if (superseded()) return;
      setEvents(null);
      if (err instanceof IdentityError) {
        setError(
          err.status === 401
            ? "Session rejected. Reconnect and retry."
            : `Identity answered ${err.status} for the receipt trail.`,
        );
      } else {
        setError(`Identity API unreachable at ${identityBase()}.`);
      }
    } finally {
      if (!superseded()) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (shownFor.current !== sessionKey) {
      // The trail on screen belongs to another principal. Drop it rather than
      // let it read as this one's while the new one loads.
      shownFor.current = sessionKey;
      run.current += 1;
      setEvents(null);
      setError(null);
    }
    if (!online) return;
    void load();
  }, [load, online, sessionKey]);

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Receipts</h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void load()}
          disabled={busy || !online}
          title="Reload receipts"
          aria-label="Reload receipts"
        >
          <IconRefresh />
        </button>
      </div>

      <div className="panel__body panel__body--tight">
        {!online ? (
          <output className="note note--warn">
            <IconAlert /> Offline.
          </output>
        ) : error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : busy && events === null ? (
          <output className="note">Asking Identity…</output>
        ) : events && events.length > 0 ? (
          <ul className="access-trail">
            {events.map((event) => (
              <ReceiptRow key={event.id} event={event} />
            ))}
          </ul>
        ) : (
          <p className="hint">No receipts yet.</p>
        )}
      </div>
    </section>
  );
}

const OUTCOME_CHIP = new Map([
  ["succeeded", "chip--ok"],
  ["denied", "chip--warn"],
  ["failed", "chip--err"],
]);

export function outcomeChip(outcome: string): string {
  return OUTCOME_CHIP.get(outcome) ?? "";
}
