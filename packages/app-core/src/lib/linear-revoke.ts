/** Provider cleanup progresses durably, including token pairs rotated during recovery. */
import {
  type DeviceConfiguration,
  readDeviceRows,
  readDeviceSecrets,
  removeDeviceConfigurationDurable,
} from "./device-connector-records.js";
import {
  cleanupGrantId,
  cleanupKey,
  cleanupQueue,
  distinctCleanup,
  forgetCleanedGrants,
  retainCleanupGrant,
  withLinearCleanup,
} from "./linear-cleanup-queue.js";
import { revokeLinearGrant } from "./linear-grant-cleanup.js";
import {
  type StoredLinearGrant,
  grantKey,
  linearConfiguration,
  linearPublicRecord,
  parseLinearGrant,
  parseLinearRuntime,
  updateLinearRecord,
} from "./linear-store.js";
import { removeLinearWebhook } from "./linear-webhooks.js";

async function cleanActor(
  id: string,
  actor: "app" | "user",
  assertUnchanged?: () => void,
): Promise<void> {
  const key = grantKey(actor);
  const queueKey = cleanupKey(actor);
  let captured = "";
  let pending: StoredLinearGrant[] = [];
  await updateLinearRecord(id, async (record, runtime) => {
    assertUnchanged?.();
    captured = record.secrets[key] ?? "";
    const grant = parseLinearGrant(captured);
    pending = distinctCleanup([
      ...cleanupQueue(record.secrets[queueKey]),
      ...(grant ? [grant] : []),
    ]);
    if (!pending.length) return record;
    const identity = runtime[actor];
    return linearPublicRecord(
      {
        ...record,
        secrets: { ...record.secrets, [queueKey]: JSON.stringify(pending) },
      },
      {
        ...runtime,
        [actor]: identity ? { ...identity, needsReauth: true } : null,
      },
    );
  });
  for (const grant of pending) {
    const cleaned = new Set([cleanupGrantId(grant)]);
    assertUnchanged?.();
    await revokeLinearGrant(
      grant,
      linearConfiguration(id).state.oauth.clientId,
      async (rotated) => {
        const next = { kind: "oauth" as const, ...rotated };
        await retainCleanupGrant(id, actor, next);
        cleaned.add(cleanupGrantId(next));
      },
    );
    await forgetCleanedGrants(id, actor, cleaned);
  }
  await updateLinearRecord(id, async (record, runtime) => {
    assertUnchanged?.();
    if ((record.secrets[key] ?? "") !== captured)
      throw new Error(
        "Linear authorization changed during cleanup; credentials were retained",
      );
    const secrets = { ...record.secrets };
    Reflect.deleteProperty(secrets, key);
    return linearPublicRecord(
      { ...record, secrets },
      { ...runtime, [actor]: null },
    );
  });
}
export async function removeLinearActor(
  id: string,
  actor: "app" | "user",
  assertUnchanged?: () => void,
): Promise<void> {
  await withLinearCleanup(id, actor, () =>
    cleanActor(id, actor, assertUnchanged),
  );
}
export async function revokeLinearConnector(id: string): Promise<void> {
  const configuration = readDeviceRows().find((row) => row.connectionId === id)
    ?.fields.self_hosted_configuration;
  const pending = readDeviceSecrets()[id]?.linear_pending;
  await removeLinearWebhook(id);
  for (const actor of ["app", "user"] as const)
    await removeLinearActor(id, actor);
  const beforeRemove = (record: DeviceConfiguration) => {
    const runtime = parseLinearRuntime(record.row.fields.linear_authorization);
    if (
      record.row.fields.self_hosted_configuration !== configuration ||
      record.secrets.linear_pending !== pending ||
      record.secrets.linear_app_grant ||
      record.secrets.linear_user_grant ||
      record.secrets.linear_cleanup_app ||
      record.secrets.linear_cleanup_user ||
      record.secrets.linear_webhook_intent ||
      runtime.webhook
    )
      throw new Error(
        "Linear configuration changed during disconnect; credentials were retained",
      );
  };
  if (!(await removeDeviceConfigurationDurable(id, beforeRemove)))
    throw new Error("Saved Linear connector not found");
}
