import {
  accountWebLoginOrigin,
  enqueueManualRotation,
  ensureRotationSchedule,
  rotationEventFor,
  rotationScheduleFor,
  setRotationEnabled,
  subscribeRotationQueue,
} from "@opensesame/app-core/lib/vault/rotation-queue.js";
import { processRotationQueue } from "@opensesame/app-core/lib/vault/rotation-relay.js";
import {
  type VaultItem,
  itemRotationMode,
  itemRotationWarning,
  itemTypeId,
} from "@opensesame/vault-core";
import { useEffect, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh } from "../../components/Icons.js";

function date(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    dateStyle: "medium",
  });
}

function days(interval: number): string {
  return interval === 1 ? "every day" : `every ${interval} days`;
}

function Schedule({
  schedule,
  onToggle,
}: {
  schedule: NonNullable<ReturnType<typeof rotationScheduleFor>>;
  onToggle: () => void;
}) {
  return (
    <>
      <div className="frow">
        <div>
          <div className="label">Automatic rotation</div>
          <p className="frow__value">
            {schedule.enabled ? "On" : "Off"} · {days(schedule.intervalDays)}
          </p>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          aria-label="Automatic rotation"
          aria-pressed={schedule.enabled}
          onClick={onToggle}
        >
          {schedule.enabled ? "On" : "Off"}
        </button>
      </div>
      <output className="hint">
        {schedule.enabled ? `Next due ${date(schedule.nextDueAt)}` : "Off"}
      </output>
    </>
  );
}

function QueueState({
  warning,
  event,
}: {
  warning: string | null;
  event: ReturnType<typeof rotationEventFor>;
}) {
  if (!warning && !event) return null;
  return (
    <>
      {warning ? <output className="hint">{warning}</output> : null}
      {event ? (
        <output className="hint">
          {event.state === "out-of-sync"
            ? "Out of sync — the rotation is queued, but no relay is configured to verify it."
            : "Rotation queued; waiting for the vault relay."}
        </output>
      ) : null}
    </>
  );
}

/**
 * Automatic rotation is a queue, not a hidden mutation. The default schedule
 * is written for a type whose provider path exists; a generator-backed type
 * with no provider path says so instead of pretending.
 */
export function RotationPanel({
  item,
  scope,
}: {
  item: VaultItem;
  /** The unlocked vault the schedule belongs to. */
  scope: string;
}) {
  const typeId = itemTypeId(item);
  const mode = itemRotationMode(typeId);
  const origin = mode === "automatic" ? accountWebLoginOrigin(item) : null;
  const warning =
    mode === "automatic" && !origin
      ? "Automatic rotation couldn't verify this account: it has no https site to rotate."
      : itemRotationWarning(typeId);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => subscribeRotationQueue(() => setRevision((value) => value + 1)),
    [],
  );

  useEffect(() => {
    if (mode === "automatic" && origin && scope)
      ensureRotationSchedule(item, scope);
  }, [item, mode, origin, scope]);

  // `revision` is the subscription's trigger; the reads below are synchronous.
  void revision;

  if (mode === "none") return null;

  const schedule =
    mode === "automatic" ? rotationScheduleFor(scope, item.id) : null;
  const event = rotationEventFor(scope, item.id);

  const toggle = () => {
    if (!schedule) return;
    setError(null);
    setRotationEnabled(scope, item.id, !schedule.enabled);
  };

  const rotate = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!scope) throw new Error("The vault is not open.");
      if (!enqueueManualRotation(item, scope)) {
        throw new Error("This item type has no generator.");
      }
      await processRotationQueue(scope);
    } catch {
      setError("The rotation could not be queued.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="detail__group" aria-label="Rotation">
      <h2 className="detail__grouphead">Rotation</h2>
      {schedule ? <Schedule schedule={schedule} onToggle={toggle} /> : null}

      <QueueState warning={warning} event={event} />

      <FailureNotice
        id={`rotation:${item.id}`}
        title="Rotation"
        message={error}
      />

      <IconKey
        label="Generate now"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void rotate()}
      >
        <IconRefresh size={16} />
      </IconKey>
    </section>
  );
}
