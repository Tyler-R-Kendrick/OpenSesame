/**
 * Receipts — the Identity plane's trail of what was decided and done.
 *
 * With no Identity API the plane is this device (ADR 0160) and the trail is
 * the vault's own: the decisions it made for its person, written when they
 * were made and read back from the sealed ledger (ADR 0162). With one, it is
 * that service's. It is not the Host's, which is the whole reason it lives
 * here rather than inside the Sessions panel it renders beneath: gating it on
 * a Host, as the first cut of ADR 0090 did, hid an Identity-plane feature
 * behind a plane it never calls. Splitting it out also takes a hundred lines
 * off the Access screen, which the structural ratchet asks of anything that
 * touches it.
 */

import {
  IdentityError,
  ensureIdentitySession,
  identityBase,
  identityJson,
} from "@opensesame/app-core/lib/identity.js";
import {
  subscribeLocalIamChanges,
  subscribeLocalIamChangesFromOtherTabs,
} from "@opensesame/app-core/lib/local-iam-events.js";
import {
  type AuditEvent,
  isReceiptEvent,
  outcomeChip,
  receiptLabel,
  receiptTarget,
} from "@opensesame/app-core/sections/access/receipts-model.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlert, IconClock, IconRefresh } from "../../components/Icons.js";
import { StatusMark, statusTone } from "../../components/StatusMark.js";
import { useIdentityPlane } from "../../lib/use-configured.js";
import { useVault } from "../../lib/vault/hooks.js";
import { formatTime } from "./format.js";
import { useReceiptNames } from "./use-receipt-names.js";

/** One line of the trail: when, what, of whom, and how it came out. */
function ReceiptRow({
  event,
  names,
}: { event: AuditEvent; names: ReadonlyMap<string, string> }) {
  const target = receiptTarget(event);
  const named = target ? (names.get(target.id) ?? target.id) : null;
  return (
    <li>
      <span className="access-trail__when">
        <IconClock /> {formatTime(event.occurredAt)}
      </span>
      <span className="access-trail__type">
        {receiptLabel(event.eventType)}
        {named ? ` · ${named}` : ""}
      </span>
      <StatusMark
        tone={statusTone(outcomeChip(event.outcome))}
        label={event.outcome}
      />
    </li>
  );
}

/** What a failed read says. The device's names no service; a remote one may. */
function failure(refused: IdentityError | null, device: boolean): string {
  if (device) return "Receipts did not load. Reload to read them again.";
  if (refused) {
    return refused.status === 401
      ? "Session rejected. Reconnect and retry."
      : `Identity answered ${refused.status} for the receipt trail.`;
  }
  return `Sign-in service unreachable at ${identityBase()}.`;
}

/**
 * The trail for one reader: read when asked, and again when a decision lands.
 * A trail read for one principal must never land under another, so a new
 * `sessionKey` drops what was shown before it loads.
 */
function useTrail(sessionKey: string, device: boolean, reachable: boolean) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useRef(0);
  const shownFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    const id = ++run.current;
    const superseded = () => run.current !== id;
    setBusy(true);
    setError(null);
    try {
      // The device's trail is the vault's: it asks for no session first, so
      // its own is minted here when the page has none yet.
      if (device) await ensureIdentitySession();
      const body = await identityJson<{ events: AuditEvent[] }>(
        "/v1/audit/events?limit=50",
      );
      if (superseded()) return;
      setEvents(body.events.filter(isReceiptEvent));
    } catch (err) {
      if (superseded()) return;
      setEvents(null);
      setError(failure(err instanceof IdentityError ? err : null, device));
    } finally {
      if (!superseded()) setBusy(false);
    }
  }, [device]);

  useEffect(() => {
    if (shownFor.current !== sessionKey) {
      // The trail on screen belongs to another reader. Drop it rather than
      // let it read as this one's while the new one loads.
      shownFor.current = sessionKey;
      run.current += 1;
      setEvents(null);
      setError(null);
    }
    if (!reachable) return;
    void load();
  }, [load, reachable, sessionKey]);

  // A decision made in this tab or another is a new receipt: read again.
  useEffect(() => {
    if (!device) return;
    const refresh = () => void load();
    const here = subscribeLocalIamChanges(refresh);
    const there = subscribeLocalIamChangesFromOtherTabs(refresh);
    return () => {
      here();
      there();
    };
  }, [device, load]);

  return { events, error, busy, load };
}

export function Receipts({
  online,
  sessionKey,
}: {
  online: boolean;
  sessionKey: string;
}) {
  const device = useIdentityPlane() === "device";
  const { tomb } = useVault();
  const names = useReceiptNames(tomb, device);
  // This device's trail is in its own vault: reading it asks nothing of a
  // network. Only a remote plane needs one.
  const reachable = device || online;
  const { events, error, busy, load } = useTrail(sessionKey, device, reachable);

  return (
    <section className="panel" id="access-receipts">
      <div className="panel__head">
        <div>
          <h2>Receipts</h2>
        </div>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          onClick={() => void load()}
          disabled={busy || !reachable}
          title="Reload receipts"
          aria-label="Reload receipts"
        >
          <IconRefresh size={15} />
        </button>
      </div>

      <div className="panel__body panel__body--tight">
        {!reachable ? (
          <output className="note note--warn">
            <IconAlert /> Offline.
          </output>
        ) : error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : busy && events === null ? (
          <output className="note">
            {device ? "Reading receipts…" : "Asking Identity…"}
          </output>
        ) : events && events.length > 0 ? (
          <ul className="access-trail">
            {events.map((event) => (
              <ReceiptRow key={event.id} event={event} names={names} />
            ))}
          </ul>
        ) : (
          <p className="hint">No receipts yet.</p>
        )}
      </div>
    </section>
  );
}
