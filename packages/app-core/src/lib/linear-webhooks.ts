/** A durable subscription intent makes provider mutations recoverable after failures. */
import { z } from "zod";
import { readDeviceSecrets } from "./device-connector-records.js";
import {
  type LinearCredential,
  createLinearWebhook,
  deleteLinearWebhook,
  listLinearWebhooks,
} from "./linear-api.js";
import { linearCredential } from "./linear-credentials.js";
import {
  linearConfiguration,
  linearFingerprint,
  linearPublicRecord,
  readLinearConnector,
  updateLinearRecord,
} from "./linear-store.js";
import {
  advanceLinearWebhookRecovery,
  finishLinearWebhookRecovery,
} from "./linear-webhook-recovery.js";
const INTENT = "linear_webhook_intent";
const IntentSchema = z.object({
  id: z.string().uuid(),
  secret: z.string().min(32),
  fingerprint: z.string(),
  url: z.string().url(),
  resourceTypes: z.array(z.string()),
});
function intent(raw?: string) {
  try {
    return IntentSchema.parse(JSON.parse(raw ?? ""));
  } catch {
    return null;
  }
}
const resourcesMatch = (left: string[], right: string[]) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
async function recoverLinearWebhook(id: string): Promise<void> {
  const recovering = readLinearConnector(id);
  if (recovering?.recovery?.phase === "cleanup") {
    if (
      !recovering.app ||
      recovering.app.needsReauth ||
      recovering.app.workspaceId !== recovering.recovery.workspaceId
    )
      throw new Error(
        "Reconnect the original Linear app account before recovering its webhook",
      );
    await removeLinearWebhook(id);
    await advanceLinearWebhookRecovery(id);
  }
}
export async function configureLinearWebhooks(id: string): Promise<void> {
  await recoverLinearWebhook(id);
  const saved = linearConfiguration(id);
  if (!saved.options.webhookEnabled) {
    await finishLinearWebhookRecovery(id);
    return;
  }
  const runtime = readLinearConnector(id);
  const url = saved.options.webhookUrl?.trim() ?? "";
  const resourceTypes = saved.options.webhookResourceTypes;
  if (
    runtime?.webhook?.url === url &&
    resourcesMatch(runtime.webhook.resourceTypes, resourceTypes)
  ) {
    await finishLinearWebhookRecovery(id);
    return;
  }
  if (runtime?.webhook)
    throw new Error(
      "Remove the existing Linear webhook before changing its receiver",
    );
  const fingerprint = linearFingerprint(saved.state, saved.options);
  const proposed = {
    id: crypto.randomUUID(),
    secret: [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
    fingerprint,
    url,
    resourceTypes,
  };
  let resumed = false;
  let pending: z.infer<typeof IntentSchema> = proposed;
  await updateLinearRecord(id, async (record) => {
    const held = intent(record.secrets[INTENT]);
    if (held) {
      if (held.fingerprint !== fingerprint)
        throw new Error(
          "Finish or remove the previous webhook setup before editing this connector",
        );
      pending = held;
      resumed = true;
      return record;
    }
    if (
      linearFingerprint(
        linearConfiguration(id).state,
        linearConfiguration(id).options,
      ) !== fingerprint
    )
      throw new Error("Linear configuration changed; retry webhook setup");
    return {
      ...record,
      secrets: { ...record.secrets, [INTENT]: JSON.stringify(proposed) },
    };
  });
  const credential = await linearCredential(id, runtime?.app ? "app" : "user");
  await ensureWebhook(credential, pending, resumed, saved.state.name);
  await updateLinearRecord(id, async (record, current) => {
    const latest = linearConfiguration(id);
    if (linearFingerprint(latest.state, latest.options) !== fingerprint)
      throw new Error("Linear configuration changed; retry webhook setup");
    if (current.webhook?.id === pending.id) return record;
    if (current.webhook)
      throw new Error("A different webhook was configured in another tab");
    const secrets = {
      ...record.secrets,
      linear_webhook_secret: pending.secret,
    };
    Reflect.deleteProperty(secrets, INTENT);
    return linearPublicRecord(
      { ...record, secrets },
      { ...current, webhook: { id: pending.id, url, resourceTypes } },
    );
  });
  await finishLinearWebhookRecovery(id);
}
export async function removeLinearWebhook(
  id: string,
  assertUnchanged?: () => void,
  verifiedCredential?: LinearCredential,
): Promise<void> {
  assertUnchanged?.();
  const runtime = readLinearConnector(id);
  const pending = intent(readDeviceSecrets()[id]?.[INTENT]);
  const webhookId = runtime?.webhook?.id ?? pending?.id;
  if (!webhookId) return;
  const credential =
    verifiedCredential ??
    (await linearCredential(id, runtime?.app ? "app" : "user"));
  await updateLinearRecord(id, async (record, current) => {
    assertUnchanged?.();
    if (current.webhook && current.webhook.id !== webhookId)
      throw new Error(
        "Linear webhook changed in another tab; reload before editing",
      );
    const exists = async () =>
      (await listLinearWebhooks(credential)).some(
        (row) => row.id === webhookId,
      );
    if (await exists()) {
      try {
        await deleteLinearWebhook(credential, webhookId);
      } catch (error) {
        if (await exists()) throw error;
      }
    }
    const secrets = { ...record.secrets };
    Reflect.deleteProperty(secrets, "linear_webhook_secret");
    Reflect.deleteProperty(secrets, INTENT);
    return linearPublicRecord(
      { ...record, secrets },
      { ...current, webhook: null },
    );
  });
}

async function ensureWebhook(
  credential: import("./linear-api.js").LinearCredential,
  pending: z.infer<typeof IntentSchema>,
  resumed: boolean,
  name: string,
): Promise<void> {
  const matches = async () => {
    const found = (await listLinearWebhooks(credential)).find(
      (row) => row.id === pending.id,
    );
    if (
      found &&
      (!found.enabled ||
        found.url !== pending.url ||
        !resourcesMatch(found.resourceTypes, pending.resourceTypes))
    )
      throw new Error("Linear webhook does not match this configuration");
    return !!found;
  };
  let exists = resumed && (await matches());
  if (!exists) {
    try {
      const created = await createLinearWebhook(credential, {
        ...pending,
        label: name,
      });
      if (created.id !== pending.id || !created.enabled)
        throw new Error("Linear did not enable the requested webhook");
      exists = true;
    } catch (error) {
      if (!(await matches())) throw error;
      exists = true;
    }
  }
  if (!exists) throw new Error("Linear did not register this webhook");
}
