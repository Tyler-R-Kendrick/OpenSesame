/**
 * Sent drops — the sender's Share-once list (Bitwarden Send parity).
 * Status, revoke, and the receipts each send earned on this device.
 */

import { listReceipts } from "@opensesame/app-core/lib/device-receipts.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import {
  type OutboundDrop,
  type OutboundDropState,
  listOutboundDrops,
  revokeOutboundDropById,
} from "@opensesame/app-core/lib/vault/outbound-drops.js";
import {
  type AuditEvent,
  outcomeChip,
  receiptLabel,
} from "@opensesame/app-core/sections/access/receipts-model.js";
import { isString } from "@opensesame/os-domain";
import { useCallback, useEffect, useState } from "react";
import { useCapabilityGate } from "../../app-root.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconRefresh, IconX } from "../../components/Icons.js";
import { StatusMark, statusTone } from "../../components/StatusMark.js";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import { useVault } from "../../lib/vault/hooks.js";
import { formatTime } from "./format.js";

const STATUS = {
  pending: { tone: "idle", label: "Pending" },
  consumed: { tone: "ok", label: "Opened" },
  expired: { tone: "warn", label: "Expired" },
  revoked: { tone: "err", label: "Revoked" },
} satisfies Record<
  OutboundDropState,
  { tone: "idle" | "ok" | "warn" | "err"; label: string }
>;

const DROP_RECEIPTS = new Set([
  "access.drop.opened",
  "access.drop.expired",
  "access.drop.locked_out",
  "access.drop.revoked",
]);

function claimIdOf(event: AuditEvent): string | null {
  const claimId = event.metadata?.claimId;
  return isString(claimId) ? claimId : null;
}

function receiptsForClaim(events: readonly AuditEvent[], claimId: string) {
  return events.filter(
    (row) => DROP_RECEIPTS.has(row.eventType) && claimIdOf(row) === claimId,
  );
}

function SentDropRow({
  drop,
  events,
  tomb,
  onRevoked,
}: {
  drop: OutboundDrop;
  events: readonly AuditEvent[];
  tomb: string;
  onRevoked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const mark = STATUS[drop.state];
  const trail = receiptsForClaim(events, drop.claimId);

  useFailureNotice(`sent-drop-revoke:${drop.claimId}`, "Sent", revokeError);

  async function revoke(): Promise<void> {
    setBusy(true);
    setRevokeError(null);
    try {
      const outcome = await revokeOutboundDropById(drop.claimId, tomb);
      if (outcome === "revoked") {
        onRevoked();
        return;
      }
      if (outcome === "already_consumed") {
        setRevokeError("This send was already opened and cannot be revoked.");
        onRevoked();
        return;
      }
      setRevokeError("This send could not be revoked on this device.");
    } catch {
      setRevokeError("This send could not be revoked. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="access-sent-drop">
      <div className="access-sent-drop__head">
        <span className="access-sent-drop__name">{drop.name}</span>
        <StatusMark tone={mark.tone} label={mark.label} />
        {drop.state === "pending" ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Revoke this send"
            title="Revoke this send"
            disabled={busy}
            onClick={() => void revoke()}
          >
            <IconX size={16} />
          </button>
        ) : null}
      </div>
      <span className="vault-row__meta">
        {formatTime(drop.createdAt)} · until {formatTime(drop.expiresAt)}
      </span>
      {trail.length > 0 ? (
        <ul
          className="access-trail access-sent-drop__trail"
          aria-label="Send receipts"
        >
          {trail.map((event) => (
            <li key={event.id}>
              <span className="access-trail__when">
                {formatTime(event.occurredAt)}
              </span>
              <span className="access-trail__type">
                {receiptLabel(event.eventType)}
              </span>
              <StatusMark
                tone={statusTone(outcomeChip(event.outcome))}
                label={event.outcome}
              />
            </li>
          ))}
        </ul>
      ) : (
        <span className="vault-row__meta">No receipts yet for this send.</span>
      )}
    </li>
  );
}

export function SentDropsPanel() {
  const { approved } = useCapabilityGate("sharing.drops");
  const { tomb } = useVault();
  const [sends, setSends] = useState<OutboundDrop[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(() => {
    setSends(listOutboundDrops(tomb));
    void listReceipts(tomb, 80)
      .then((rows) => {
        setEvents(rows);
        setFailed(false);
      })
      .catch(() => {
        setEvents([]);
        setFailed(true);
      });
  }, [tomb]);

  useEffect(() => {
    if (!approved) return;
    const off = subscribeLocalIamChanges(reload);
    reload();
    return off;
  }, [approved, reload]);

  if (!approved) return null;

  return (
    <section
      className="access-sent-drops"
      aria-labelledby="access-sent-drops-head"
    >
      <div className="section__subhead">
        <h2 id="access-sent-drops-head">Sent</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Refresh sent list"
          title="Refresh sent list"
          onClick={reload}
        >
          <IconRefresh size={16} />
        </button>
      </div>
      {failed ? (
        <FailureNotice
          id="sent-drops-receipts"
          title="Sent"
          message="Receipts for sends did not load. Refresh to try again."
        />
      ) : null}
      {sends.length === 0 ? (
        <p className="hint">
          No sends yet. Share once from a secret to list it here.
        </p>
      ) : (
        <ul className="access-sent-drops__list">
          {sends.map((drop) => (
            <SentDropRow
              key={drop.claimId}
              drop={drop}
              events={events}
              tomb={tomb}
              onRevoked={reload}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
