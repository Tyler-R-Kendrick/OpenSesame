/** Save a Linear connector only after provider verification; OAuth continues at consent. */
import type { DraftState } from "./connect-draft.js";
import type { Connection } from "./connections.js";
import { readDeviceSecrets } from "./device-connector-records.js";
import {
  deviceConnection,
  saveDeviceConnectorConfigurationDurable,
} from "./device-connectors.js";
import { reserveLinearAuthorizationWindow } from "./linear-auth-reservation.js";
import { beginLinearAuthorization } from "./linear-auth.js";
import {
  checkLinearEdit,
  linearSaveInput,
  linearSnapshot,
  prepareLinearEdit,
  verifyLinearKey,
} from "./linear-config-input.js";
import { linearConnectorProblems } from "./linear-config-validation.js";
import { removeLinearActor } from "./linear-revoke.js";
import {
  type LinearActor,
  type LinearRuntime,
  emptyLinearRuntime,
  linearActorNeedsConsent,
  linearConfiguration,
  readLinearConnector,
  requireLinearConnection,
} from "./linear-store.js";
import { finishLinearWebhookRecovery } from "./linear-webhook-recovery.js";
import { configureLinearWebhooks } from "./linear-webhooks.js";
import type { SelfHostedConnectorOptions } from "./self-hosted-connectors-schema.js";
export {
  beginLinearAuthorization,
  finishLinearAuthorization,
  linearRedirectUri,
} from "./linear-auth.js";
export { linearConnectorProblems } from "./linear-config-validation.js";
export { readLinearConnector } from "./linear-store.js";
export {
  linearReconnectPlan,
  type LinearReconnectPlan,
} from "./linear-webhook-recovery.js";
let deploymentClient = "";
export function applyLinearClientId(value?: string): void {
  deploymentClient = value?.trim() ?? "";
}
export function linearClientId(): string {
  return deploymentClient;
}
/** Public cleanup availability never exposes the rejected or rotated credential. */
export function linearActorCleanupPending(
  id: string,
  actor: LinearActor,
): boolean {
  return !!readDeviceSecrets()[id]?.[`linear_cleanup_${actor}`];
}
export async function retryLinearActorCleanup(
  id: string,
  actor: LinearActor,
): Promise<Connection> {
  const options = linearConfiguration(id).options;
  if (options[actor === "app" ? "appScopes" : "userScopes"].length > 0)
    throw new Error(
      "Reconnect the selected Linear account to finish its authorization cleanup",
    );
  const expected = JSON.stringify(linearConfiguration(id));
  const assertUnchanged = () => {
    if (JSON.stringify(linearConfiguration(id)) !== expected)
      throw new Error(
        "Linear configuration changed during cleanup; reload before retrying",
      );
  };
  await removeLinearActor(id, actor, assertUnchanged);
  const runtime = readLinearConnector(id);
  if (
    actor === "app" &&
    runtime?.recovery?.phase === "configure" &&
    !runtime.webhook &&
    !readDeviceSecrets()[id]?.linear_webhook_intent
  )
    await finishLinearWebhookRecovery(id);
  return requireLinearConnection(id);
}
function nextLinearActor(
  state: DraftState,
  options: SelfHostedConnectorOptions,
  runtime: LinearRuntime,
): LinearActor | null {
  if (state.method !== "oauth") return null;
  if (linearActorNeedsConsent(runtime, options, "app")) return "app";
  return linearActorNeedsConsent(runtime, options, "user") ? "user" : null;
}
function needsConsentWindow(
  previous: ReturnType<typeof linearConfiguration> | null,
  state: DraftState,
  options: SelfHostedConnectorOptions,
  runtime: LinearRuntime,
  id?: string,
): boolean {
  if (state.method !== "oauth") return false;
  if (nextLinearActor(state, options, runtime)) return true;
  if (!previous) return false;
  const changed = ["appScopes", "userScopes"] as const;
  if (
    changed.some(
      (field) =>
        JSON.stringify([...previous.options[field]].sort()) !==
        JSON.stringify([...options[field]].sort()),
    )
  )
    return true;
  return Boolean(
    runtime.webhook ||
      runtime.recovery ||
      (id && readDeviceSecrets()[id]?.linear_webhook_intent),
  );
}
export async function configureLinearConnector(
  state: DraftState,
  options: SelfHostedConnectorOptions,
  id?: string,
  onPersisted?: (connectionId: string) => void,
): Promise<Connection> {
  const problems = linearConnectorProblems(state, options, id);
  if (problems.length) throw new Error(problems.join(". "));
  const previous = id ? linearConfiguration(id) : null;
  const runtime = id
    ? (readLinearConnector(id) ?? emptyLinearRuntime())
    : emptyLinearRuntime();
  checkLinearEdit(previous, state, options, runtime);
  const reservation = needsConsentWindow(previous, state, options, runtime, id)
    ? reserveLinearAuthorizationWindow()
    : null;
  try {
    const before = linearSnapshot(id);
    const key = await verifyLinearKey(state, options, runtime, id);
    if (id && linearSnapshot(id) !== before)
      throw new Error(
        "Linear configuration changed in another tab; reload before saving",
      );
    const expected =
      id && previous
        ? await prepareLinearEdit(id, previous, state, options, runtime)
        : before;
    const saved = await saveDeviceConnectorConfigurationDurable(
      () => linearSaveInput(state, options, runtime, key, expected, id),
      id,
    );
    onPersisted?.(saved.connectionId);
    // Edits can revoke a broader grant or add webhook cleanup obligations.
    const actor = nextLinearActor(state, options, runtime);
    if (actor)
      await beginLinearAuthorization(
        saved.connectionId,
        actor,
        reservation ?? undefined,
      );
    else await configureLinearWebhooks(saved.connectionId);
    const connection = deviceConnection(saved.connectionId);
    if (!connection) throw new Error("Saved Linear connector not found");
    return connection;
  } finally {
    reservation?.release();
  }
}
/** Human UI only; fetched only inside the explicit clipboard action. */
export function linearWebhookSecret(id: string): string | null {
  return readLinearConnector(id)?.webhook
    ? (readDeviceSecrets()[id]?.linear_webhook_secret ?? null)
    : null;
}
