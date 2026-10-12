import {
  linearReconnectPlan,
  readLinearConnector,
  retryLinearActorCleanup,
} from "@opensesame/app-core/lib/linear-connectors.js";
import { configureLinearWebhooks } from "@opensesame/app-core/lib/linear-webhooks.js";
import { readSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { IconRefresh } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";

export function linearReconnectActionTitle(
  connectorId: string,
  action: string,
): string {
  const plan = linearReconnectPlan(connectorId);
  if (!plan.cleanupNeeded) return action;
  return `${action}. Remove the previous webhook in its original workspace.${
    plan.temporaryAdmin
      ? " Linear requests temporary admin permission for cleanup, then authorization for selected app scopes."
      : " Original workspace authorization is required for webhook cleanup."
  }`;
}

export function LinearReconnectHint({ connectorId }: { connectorId: string }) {
  const plan = linearReconnectPlan(connectorId);
  if (!plan.cleanupNeeded) return null;
  return (
    <StatusMark
      tone="warn"
      label={
        plan.temporaryAdmin
          ? "Webhook cleanup pending in the original workspace; temporary admin permission required before selected app scopes."
          : "Webhook cleanup pending; original workspace authorization required."
      }
    />
  );
}

export function LinearWebhookRetry({
  connectorId,
  busy,
  onFlash,
  onChanged,
}: {
  connectorId: string;
  busy: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const runtime = readLinearConnector(connectorId);
  const saved = readSelfHostedConnector(connectorId);
  const needed =
    runtime?.recovery || (saved?.options.webhookEnabled && !runtime?.webhook);
  if (!needed || !runtime?.app || runtime.app.needsReauth) return null;
  async function retry() {
    setRetrying(true);
    try {
      await configureLinearWebhooks(connectorId);
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
      onChanged();
    } finally {
      setRetrying(false);
    }
  }
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label="Retry webhook setup"
      title="Retry webhook setup"
      disabled={busy || retrying}
      onClick={() => void retry()}
    >
      <IconRefresh size={16} />
    </button>
  );
}

export function LinearActorCleanup({
  connectorId,
  actor,
  busy,
  onFlash,
  onChanged,
}: {
  connectorId: string;
  actor: "app" | "user";
  busy: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    setRetrying(true);
    try {
      await retryLinearActorCleanup(connectorId, actor);
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setRetrying(false);
      onChanged();
    }
  }
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label="Retry authorization cleanup"
      title="Retry authorization cleanup"
      disabled={busy || retrying}
      onClick={() => void retry()}
    >
      <IconRefresh size={16} />
    </button>
  );
}
