/**
 * Sent drops — the sender's Share-once list (Bitwarden Send parity).
 * Status, revoke, and the receipts each send earned on this device.
 */

import { listReceipts } from "@opensesame/app-core/lib/device-receipts.js";
import {
  subscribeLocalIamChanges,
  subscribeLocalIamChangesFromOtherTabs,
} from "@opensesame/app-core/lib/local-iam-events.js";
import {
  type OutboundDrop,
  type OutboundDropState,
  listOutboundDrops,
  revokeOutboundDropById,
} from "@opensesame/app-core/lib/vault/outbound-drops.js";
import {
  type AuditEvent,
  outcomeChip,
  receiptWords,
} from "@opensesame/app-core/sections/access/receipts-model.js";
import { isString } from "@opensesame/os-domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCapabilityGate } from "../../app-root.js";
import { IconKey } from "../../components/IconKey.js";
import { IconX } from "../../components/Icons.js";
import { StatusMark, statusTone } from "../../components/StatusMark.js";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import { useVault } from "../../lib/vault/hooks.js";
import { formatTime } from "./format.js";

const STATUS = {
  pending: { tone: "idle", label: "Pending" },
  consumed: { tone: "ok", label: "Opened" },
  expired: { tone: "warn", label: "Expired" },
  revoked: { tone: "err", label: "Revoked" },
  locked_out: { tone: "err", label: "Locked out" },
} satisfies Record<
  OutboundDropState,
  { tone: "idle" | "ok" | "warn" | "err"; label: string }
>;

const DROP_RECEIPTS = new Set([
  "access.drop.sent",
  "access.drop.opened",
  "access.drop.expired",
  "access.drop.locked_out",
  "access.drop.refused",
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

function SentDropTrail({ trail }: { trail: readonly AuditEvent[] }) {
  if (trail.length === 0) return null;
  return (
    <ul className="access-trail access-sent-drop__trail">
      {trail.map((event) => (
        <li key={event.id}>
          <span className="access-trail__when">
            {formatTime(event.occurredAt)}
          </span>
          <span className="access-trail__type">{receiptWords(event)}</span>
          <StatusMark
            tone={statusTone(outcomeChip(event.outcome))}
            label={event.outcome}
          />
        </li>
      ))}
    </ul>
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
  const [armed, setArmed] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  useEffect(() => {
    if (!busy) setArmed(false);
  }, [busy]);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  const mark = drop.portable
    ? { tone: "idle" as const, label: "Copy shared" }
    : STATUS[drop.state];
  // An old client could write a revoked receipt after only changing its
  // local ledger. Such a receipt never revoked a portable copy.
  const trail = receiptsForClaim(events, drop.claimId).filter(
    (row) =>
      row.eventType !== "access.drop.revoked" ||
      (!drop.portable && drop.state === "revoked"),
  );
  const revokeLabel = armed ? "Confirm" : "Revoke";

  useFailureNotice(`sent-drop-revoke:${drop.claimId}`, "Sent", revokeError);

  async function revoke(): Promise<void> {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setBusy(true);
    setRevokeError(null);
    try {
      const outcome = await revokeOutboundDropById(drop.claimId, tomb);
      if (outcome === "revoked") {
        onRevoked();
        return;
      }
      if (outcome === "already_consumed") {
        setRevokeError("Already opened.");
        onRevoked();
        return;
      }
      setRevokeError("Revoke unavailable.");
    } catch {
      setRevokeError("Revoke failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="access-sent-drop">
      <div className="access-sent-drop__head">
        <span className="access-sent-drop__name">{drop.name}</span>
        <StatusMark tone={mark.tone} label={mark.label} />
        {drop.state === "pending" && !drop.portable ? (
          <IconKey
            label={revokeLabel}
            armed={armed}
            disabled={busy}
            onBlur={() => setArmed(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setArmed(false);
            }}
            onClick={() => void revoke()}
          >
            <IconX size={16} />
          </IconKey>
        ) : null}
      </div>
      <span className="vault-row__meta">{formatTime(drop.createdAt)}</span>
      {drop.portable ? (
        <p className="hint">
          Saved copies can reopen after expiry. Revocation is unavailable.
        </p>
      ) : null}
      <SentDropTrail trail={trail} />
    </li>
  );
}

export function SentDropsPanel() {
  const { approved } = useCapabilityGate("sharing.drops");
  const { tomb } = useVault();
  const [sends, setSends] = useState<OutboundDrop[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  // A receipt read that lands after unmount must not set state: the update
  // has nowhere to go and surfaces as an unhandled rejection in tests.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reload = useCallback(() => {
    setSends(listOutboundDrops(tomb));
    void listReceipts(tomb, 80)
      .then((rows) => {
        if (mounted.current) setEvents(rows);
      })
      .catch(() => {
        if (mounted.current) setEvents([]);
      });
  }, [tomb]);

  useEffect(() => {
    if (!approved) return;
    reload();
    const here = subscribeLocalIamChanges(reload);
    const there = subscribeLocalIamChangesFromOtherTabs(reload);
    return () => {
      here();
      there();
    };
  }, [approved, reload]);

  if (!approved) return null;

  return (
    <section
      className="access-sent-drops"
      aria-labelledby="access-sent-drops-head"
    >
      <div className="section__subhead">
        <h2 id="access-sent-drops-head">Sent</h2>
      </div>
      {sends.length === 0 ? (
        <p className="hint">No sends yet.</p>
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
