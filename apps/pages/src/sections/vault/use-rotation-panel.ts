import {
  type VaultResetRunPhase,
  passwordResetVaultUiSeams,
} from "@opensesame/app-core/lib/password-reset/vault-ui-seam.js";
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
import { promptConfigurePasswordReset } from "./rotation-password-reset-prompt.js";

function resetRunHint(phase: VaultResetRunPhase | null): string | null {
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

export function useRotationPanel(item: VaultItem, scope: string) {
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
  const { plan } = useComposition();
  const featureOn =
    plan?.approvedCapabilities.includes("ai.password-reset") === true;

  useEffect(
    () => subscribeRotationQueue(() => setRevision((value) => value + 1)),
    [],
  );
  useEffect(
    () =>
      passwordResetVaultUiSeams.subscribeRuns(() =>
        setRevision((value) => value + 1),
      ),
    [],
  );

  useEffect(() => {
    if (mode === "automatic" && origin && scope)
      ensureRotationSchedule(item, scope);
  }, [item, mode, origin, scope]);

  void revision;

  const schedule =
    mode === "automatic" ? rotationScheduleFor(scope, item.id) : null;
  const event = rotationEventFor(scope, item.id);
  const runPhase = passwordResetVaultUiSeams.runPhaseFor(scope, item.id);
  const runHint = resetRunHint(runPhase);

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
      if (featureOn) {
        const readiness = await passwordResetVaultUiSeams.evaluateReadiness(
          plan?.approvedCapabilities,
        );
        if (!readiness.ok) {
          promptConfigurePasswordReset(readiness, navigate);
          return;
        }
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

  return {
    mode,
    warning,
    schedule,
    event,
    runHint,
    busy,
    error,
    toggle,
    rotate,
  };
}
