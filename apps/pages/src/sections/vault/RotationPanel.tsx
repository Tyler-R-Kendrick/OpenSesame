import type {
  rotationEventFor,
  rotationScheduleFor,
} from "@opensesame/app-core/lib/vault/rotation-queue.js";
import type { VaultItem } from "@opensesame/vault-core";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh } from "../../components/Icons.js";
import { useRotationPanel } from "./use-rotation-panel.js";

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
  runHint,
}: {
  warning: string | null;
  event: ReturnType<typeof rotationEventFor>;
  runHint: string | null;
}) {
  if (!warning && !event && !runHint) return null;
  return (
    <>
      {warning ? <output className="hint">{warning}</output> : null}
      {runHint ? <output className="hint">{runHint}</output> : null}
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
  const {
    mode,
    warning,
    schedule,
    event,
    runHint,
    busy,
    error,
    toggle,
    rotate,
  } = useRotationPanel(item, scope);

  if (mode === "none") return null;

  return (
    <section className="detail__group" aria-label="Rotation">
      <h2 className="detail__grouphead">Rotation</h2>
      {schedule ? <Schedule schedule={schedule} onToggle={toggle} /> : null}

      <QueueState warning={warning} event={event} runHint={runHint} />

      <FailureNotice
        id={`rotation:${item.id}`}
        title="Rotation"
        message={error}
      />

      <IconKey
        label="Generate new password"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void rotate()}
      >
        <IconRefresh size={16} />
      </IconKey>
    </section>
  );
}
