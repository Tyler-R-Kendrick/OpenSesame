import { readDeviceSecrets } from "./device-connector-records.js";
/** Reconsent retains a workspace-bound obligation to remove the old subscription. */
import { LinearApiError } from "./linear-api.js";
import {
  linearConfiguration,
  linearGrant,
  linearPublicRecord,
  readLinearConnector,
  updateLinearRecord,
} from "./linear-store.js";
export type LinearReconnectPlan = {
  cleanupNeeded: boolean;
  temporaryAdmin: boolean;
};
export function linearReconnectPlan(id: string): LinearReconnectPlan {
  const runtime = readLinearConnector(id);
  const cleanupNeeded =
    runtime?.recovery?.phase === "configure"
      ? false
      : hasLinearWebhookObligation(id);
  return {
    cleanupNeeded,
    temporaryAdmin:
      cleanupNeeded &&
      !linearConfiguration(id).options.appScopes.includes("admin"),
  };
}

export function hasLinearWebhookObligation(id: string): boolean {
  const runtime = readLinearConnector(id);
  return !!(
    runtime?.recovery ||
    runtime?.webhook ||
    readDeviceSecrets()[id]?.linear_webhook_intent
  );
}

export function linearCleanupNeedsAuthorization(
  id: string,
  error: Error,
): boolean {
  const identity = readLinearConnector(id)?.app;
  const grant = linearGrant(id, "app");
  return (
    !!identity?.needsReauth ||
    !grant ||
    (grant.kind === "oauth" &&
      grant.expiresAt !== null &&
      grant.expiresAt <= Date.now() &&
      !grant.refreshToken) ||
    (error instanceof LinearApiError &&
      (error.code === "authorization" || error.code === "permission"))
  );
}

export async function deferLinearWebhookCleanup(
  id: string,
  forceCleanup = false,
): Promise<boolean> {
  let deferred = false;
  await updateLinearRecord(id, async (record, runtime) => {
    if (
      !runtime.recovery &&
      !runtime.webhook &&
      !record.secrets.linear_webhook_intent
    )
      return record;
    const workspaceId =
      runtime.recovery?.workspaceId ??
      runtime.app?.workspaceId ??
      runtime.user?.workspaceId;
    if (!workspaceId)
      throw new Error(
        "The original Linear workspace is required to recover this webhook",
      );
    deferred = true;
    return linearPublicRecord(record, {
      ...runtime,
      app: runtime.app ? { ...runtime.app, needsReauth: true } : null,
      recovery:
        forceCleanup &&
        (runtime.webhook || record.secrets.linear_webhook_intent)
          ? { workspaceId, phase: "cleanup" }
          : (runtime.recovery ?? { workspaceId, phase: "cleanup" }),
    });
  });
  return deferred;
}

export async function advanceLinearWebhookRecovery(id: string): Promise<void> {
  await updateLinearRecord(id, async (record, runtime) => {
    if (!runtime.recovery) return record;
    if (runtime.webhook || record.secrets.linear_webhook_intent)
      throw new Error(
        "Finish removing the old Linear webhook before recovering its configuration",
      );
    return linearPublicRecord(record, {
      ...runtime,
      recovery: { ...runtime.recovery, phase: "configure" },
    });
  });
}

/** A temporary admin grant must be replaced by the permissions the user selected. */
export async function finishLinearWebhookRecovery(id: string): Promise<void> {
  await updateLinearRecord(id, async (record, runtime) => {
    if (!runtime.recovery) return record;
    if (runtime.recovery.phase !== "configure")
      throw new Error(
        "Finish Linear webhook cleanup before completing recovery",
      );
    const options = linearConfiguration(id).options;
    if (options.webhookEnabled && !runtime.webhook)
      throw new Error(
        "Configure the requested Linear webhook before completing recovery",
      );
    if (!options.webhookEnabled && runtime.webhook)
      throw new Error(
        "Remove the previous Linear webhook before completing recovery",
      );
    if (record.secrets.linear_webhook_intent)
      throw new Error(
        "Finish the pending Linear webhook before completing recovery",
      );
    if (
      runtime.app?.grantedScopes.includes("admin") &&
      !options.appScopes.includes("admin")
    )
      return linearPublicRecord(record, {
        ...runtime,
        app: { ...runtime.app, needsReauth: true },
      });
    return linearPublicRecord(record, { ...runtime, recovery: undefined });
  });
}
