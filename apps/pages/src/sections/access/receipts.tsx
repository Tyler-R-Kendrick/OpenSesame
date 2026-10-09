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
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconRefresh } from "../../components/Icons.js";
import { StatusMark, statusTone } from "../../components/StatusMark.js";
import { useIdentityPlane } from "../../lib/use-configured.js";
import { useVault } from "../../lib/vault/hooks.js";
import {
  AccessDetail,
  AccessFact,
  AccessRecords,
  useAccessRecord,
} from "./AccessRecords.js";
import { formatTime } from "./format.js";
import { useReceiptNames } from "./use-receipt-names.js";

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
  // Decisions the device made that are not in the trail yet (ADR 0162).
  const [pending, setPending] = useState(0);
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
      const body = await identityJson<{
        events: AuditEvent[];
        pending?: number;
      }>("/v1/audit/events?limit=50");
      if (superseded()) return;
      setEvents(body.events.filter(isReceiptEvent));
      setPending(body.pending ?? 0);
    } catch (err) {
      if (superseded()) return;
      setEvents(null);
      setPending(0);
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
      setPending(0);
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

  return { events, pending, error, busy, load };
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
  const { events, pending, error, busy, load } = useTrail(
    sessionKey,
    device,
    reachable,
  );
  const failed = reachable ? error : "Offline.";

  const selection = useAccessRecord("access-receipts", "sessions");
  const selected = events?.find((event) => event.id === selection.id);
  return (
    <AccessRecords
      title="Receipts"
      emptyMessage={
        failed
          ? "Unavailable"
          : busy && events === null
            ? "Loading…"
            : "No receipts yet."
      }
      selection={selection}
      rows={(events ?? []).map((event) => {
        const target = receiptTarget(event);
        return {
          id: event.id,
          label: `${receiptLabel(event.eventType)}${target ? ` · ${names.get(target.id) ?? target.id}` : ""}`,
          extension: "receipt",
          to: selection.path(event.id),
        };
      })}
      commands={
        <ReceiptCommands
          pending={pending}
          failed={failed}
          reachable={reachable}
          busy={busy}
          reload={() => void load()}
        />
      }
      status={
        <>
          <FailureNotice
            id="access:receipts"
            title="Receipts"
            message={failed}
            tone={reachable ? "err" : "warn"}
          />
          {busy && events === null ? (
            <output>{device ? "Reading receipts…" : "Asking Identity…"}</output>
          ) : null}
        </>
      }
    >
      {selected ? (
        <AccessDetail
          title={receiptLabel(selected.eventType)}
          kind="Receipt"
          actions={
            <StatusMark
              tone={statusTone(outcomeChip(selected.outcome))}
              label={selected.outcome}
            />
          }
        >
          <AccessFact label="Time" value={formatTime(selected.occurredAt)} />
          <AccessFact label="Outcome" value={selected.outcome} />
          <AccessFact
            label="Target"
            value={receiptTarget(selected)?.id ?? "—"}
          />
          <AccessFact label="Reference" value={selected.id} />
        </AccessDetail>
      ) : null}
    </AccessRecords>
  );
}

function ReceiptCommands({
  pending,
  failed,
  reachable,
  busy,
  reload,
}: {
  pending: number;
  failed: string | null;
  reachable: boolean;
  busy: boolean;
  reload: () => void;
}) {
  return (
    <>
      {pending > 0 ? (
        <StatusMark tone="warn" label={`${pending} receipts not written yet`} />
      ) : null}
      {failed ? (
        <StatusMark tone={reachable ? "err" : "warn"} label={failed} />
      ) : null}
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        onClick={reload}
        disabled={busy || !reachable}
        title="Reload receipts"
        aria-label="Reload receipts"
      >
        <IconRefresh size={15} />
      </button>
    </>
  );
}
