import { pushNotice } from "@opensesame/app-core/lib/notices.js";
import {
  subscribeVaultResetRuns,
  vaultResetRunFor,
} from "@opensesame/app-core/lib/password-reset/vault-run-tracker.js";
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
import { useNavigate } from "react-router";
import { useComposition } from "../../bindings/capabilities.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh } from "../../components/Icons.js";
import { usePasswordResetReadiness } from "./use-password-reset-readiness.js";

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

function resetRunHint(
  phase: "queued" | "in-progress" | "needs-you" | "done" | "failed" | undefined,
): string | null {
  switch (phase) {
    case "queued":
      return "Password reset queued.";
    case "in-progress":
      return "Password reset in progress.";
    case "needs-you":
      return "Password reset needs you on the provider site.";
    case "failed":
      return "Password reset could not finish.";
    default:
      return null;
  }
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
  const navigate = useNavigate();
  const resetReadiness = usePasswordResetReadiness();
  const { plan } = useComposition();
  const featureOn =
    plan?.approvedCapabilities.includes("ai.password-reset") === true;

  useEffect(
    () => subscribeRotationQueue(() => setRevision((value) => value + 1)),
    [],
  );
  useEffect(
    () => subscribeVaultResetRuns(() => setRevision((value) => value + 1)),
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
  const run = vaultResetRunFor(scope, item.id);
  const runHint = resetRunHint(run?.phase);

  const toggle = () => {
    if (!schedule) return;
    setError(null);
    setRotationEnabled(scope, item.id, !schedule.enabled);
  };

  const promptConfigureReset = () => {
    const reason =
      resetReadiness?.ok === false ? resetReadiness.reason : "feature-off";
    const body =
      reason === "feature-off"
        ? "Turn on Password reset under Settings › Features, then connect a computer-use runtime under Integrations and choose a model under AI."
        : reason === "runtime"
          ? "Connect a computer-use runtime under Settings › Integrations › Password reset."
          : "Choose a model for password reset under Settings › Features › AI.";
    pushNotice({
      kind: "status",
      tone: "info",
      title: "Password reset",
      body,
      act: {
        label: "Settings",
        run: () => {
          if (reason === "runtime") {
            navigate("/settings/integrations#integration-password-reset");
            return;
          }
          if (reason === "model") {
            navigate("/settings/features#feature-ai");
            return;
          }
          navigate("/settings/features#feature-password-reset");
        },
      },
    });
  };

  const rotate = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!scope) throw new Error("The vault is not open.");
      if (featureOn && resetReadiness && !resetReadiness.ok) {
        promptConfigureReset();
        return;
      }
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
