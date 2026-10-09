/** Save a Linear connector only after provider verification; OAuth continues at consent. */
import type { DraftState } from "./connect-draft.js";
import type { Connection } from "./connections.js";
import { readDeviceSecrets } from "./device-connector-records.js";
import {
  deviceConnection,
  saveDeviceConnectorConfigurationDurable,
} from "./device-connectors.js";
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
export async function configureLinearConnector(
  state: DraftState,
  options: SelfHostedConnectorOptions,
  id?: string,
): Promise<Connection> {
  const problems = linearConnectorProblems(state, options, id);
  if (problems.length) throw new Error(problems.join(". "));
  const previous = id ? linearConfiguration(id) : null;
  const runtime = id
    ? (readLinearConnector(id) ?? emptyLinearRuntime())
    : emptyLinearRuntime();
  checkLinearEdit(previous, state, options, runtime);
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
  const actor =
    state.method === "oauth"
      ? linearActorNeedsConsent(runtime, options, "app")
        ? "app"
        : linearActorNeedsConsent(runtime, options, "user")
          ? "user"
          : null
      : null;
  if (actor) await beginLinearAuthorization(saved.connectionId, actor);
  else await configureLinearWebhooks(saved.connectionId);
  const connection = deviceConnection(saved.connectionId);
  if (!connection) throw new Error("Saved Linear connector not found");
  return connection;
}
/** Human UI only; fetched only inside the explicit clipboard action. */
export function linearWebhookSecret(id: string): string | null {
  return readLinearConnector(id)?.webhook
    ? (readDeviceSecrets()[id]?.linear_webhook_secret ?? null)
    : null;
}
