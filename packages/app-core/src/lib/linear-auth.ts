/** Linear's public-client OAuth flow: S256, actor-bound state, verified workspace. */
import { env } from "../host.js";
import { page } from "../ports.js";
import { readDeviceSecrets } from "./device-connector-records.js";
import { kvDurability } from "./kv.js";
import { exchangeLinearCode } from "./linear-api.js";
import { saveLinearConsent } from "./linear-consent-save.js";
export { checkLinearWorkspace } from "./linear-consent-save.js";
import { removeLinearActor } from "./linear-revoke.js";
import {
  LINEAR_PENDING,
  type LinearActor,
  type PendingLinear,
  PendingLinearSchema,
  linearActorNeedsConsent,
  linearConfiguration,
  linearFingerprint,
  readLinearConnector,
  requireLinearConnection,
  updateLinearRecord,
} from "./linear-store.js";
import {
  deferLinearWebhookCleanup,
  finishLinearWebhookRecovery,
} from "./linear-webhook-recovery.js";
import { removeLinearWebhook } from "./linear-webhooks.js";
import { configureLinearWebhooks } from "./linear-webhooks.js";

const MAX_AGE = 10 * 60_000;
export function linearRedirectUri(): string {
  return new URL(`${env().BASE_URL}auth/linear.html`, page().location.origin)
    .href;
}
function random(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function requested(actor: LinearActor, id: string): string[] {
  const options = linearConfiguration(id).options;
  return [
    ...new Set([
      "read",
      ...options[actor === "app" ? "appScopes" : "userScopes"],
      ...(actor === "app" &&
      readLinearConnector(id)?.recovery?.phase === "cleanup"
        ? ["admin"]
        : []),
    ]),
  ];
}
async function finishCleanupOnly(
  id: string,
  actor: LinearActor,
): Promise<boolean> {
  const saved = linearConfiguration(id);
  if (
    actor === "app" &&
    readLinearConnector(id)?.recovery?.phase === "configure" &&
    saved.options.appScopes.length === 0 &&
    !readLinearConnector(id)?.webhook &&
    !readDeviceSecrets()[id]?.linear_webhook_intent
  ) {
    await removeLinearActor(id, "app");
    await finishLinearWebhookRecovery(id);
    return true;
  }
  return false;
}
export async function beginLinearAuthorization(
  id: string,
  actor: LinearActor,
): Promise<void> {
  if (kvDurability() === "memory")
    throw new Error(
      "Linear OAuth requires browser storage that survives the consent redirect; enable browser storage or use an API key",
    );
  const saved = linearConfiguration(id);
  if (saved.state.method !== "oauth" || !saved.state.oauth.clientId.trim())
    throw new Error("Enter the registered Linear OAuth client ID first");
  if (await finishCleanupOnly(id, actor)) return;
  const deferred = actor === "app" && (await deferLinearWebhookCleanup(id));
  if (
    readLinearConnector(id)?.[actor] ||
    readDeviceSecrets()[id]?.[`linear_cleanup_${actor}`]
  ) {
    if (actor === "app" && !deferred) await removeLinearWebhook(id);
    await removeLinearActor(id, actor);
  }
  const verifier = random();
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...hash))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const pending: PendingLinear = {
    state: random(),
    verifier,
    clientId: saved.state.oauth.clientId,
    redirectUri: linearRedirectUri(),
    actor,
    scopes: requested(actor, id),
    createdAt: Date.now(),
    fingerprint: linearFingerprint(saved.state, saved.options),
  };
  await updateLinearRecord(id, async (record) => {
    const current = linearConfiguration(id);
    if (
      linearFingerprint(current.state, current.options) !== pending.fingerprint
    )
      throw new Error("Linear configuration changed; restart consent");
    return {
      ...record,
      secrets: { ...record.secrets, [LINEAR_PENDING]: JSON.stringify(pending) },
    };
  });
  const url = new URL("https://linear.app/oauth/authorize");
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: pending.clientId,
    redirect_uri: pending.redirectUri,
    state: pending.state,
    scope: pending.scopes.join(","),
    actor,
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    url.searchParams.set(name, value);
  page().location.assign(url.href);
}
function parsePending(raw?: string): PendingLinear | null {
  try {
    return PendingLinearSchema.parse(JSON.parse(raw ?? ""));
  } catch {
    return null;
  }
}
function callbackParameters(search: string): URLSearchParams | null {
  const params = new URLSearchParams(search);
  if (!params.has("linear_state")) return null;
  const current = new URL(page().location.href);
  for (const key of ["linear_state", "linear_code", "linear_error"])
    current.searchParams.delete(key);
  page().replaceUrl(current.href);
  if (
    ["linear_state", "linear_code", "linear_error"].some(
      (key) => params.getAll(key).length > 1,
    ) ||
    params.has("linear_code") === params.has("linear_error")
  )
    throw new Error(
      "Invalid Linear authorization response; reconnect this account",
    );
  return params;
}
async function claimTransaction(state: string | null) {
  const match = Object.entries(readDeviceSecrets()).find(
    ([, secrets]) => parsePending(secrets[LINEAR_PENDING])?.state === state,
  );
  if (!match)
    throw new Error(
      "Linear authorization could not be matched or was already used; reconnect this account",
    );
  const id = match[0];
  let pending: PendingLinear | null = null;
  await updateLinearRecord(id, async (record) => {
    const held = parsePending(record.secrets[LINEAR_PENDING]);
    if (!held || held.state !== state)
      throw new Error("Linear authorization was already used");
    pending = held;
    const secrets = { ...record.secrets };
    Reflect.deleteProperty(secrets, LINEAR_PENDING);
    return { ...record, secrets };
  });
  if (!pending) throw new Error("Linear authorization could not be matched");
  const transaction: PendingLinear = pending;
  if (
    Date.now() - transaction.createdAt > MAX_AGE ||
    transaction.createdAt > Date.now() ||
    transaction.redirectUri !== linearRedirectUri()
  )
    throw new Error("Linear authorization expired; reconnect this account");
  const saved = linearConfiguration(id);
  if (transaction.fingerprint !== linearFingerprint(saved.state, saved.options))
    throw new Error(
      "Linear configuration changed during consent; reconnect this account",
    );
  return { id, transaction };
}
async function finish(search: string) {
  const params = callbackParameters(search);
  if (!params) return null;
  const { id, transaction } = await claimTransaction(
    params.get("linear_state"),
  );
  if (params.has("linear_error"))
    throw new Error(
      "Linear authorization was declined; your connector is not authorized",
    );
  const code = params.get("linear_code");
  if (!code || code.length > 8192)
    throw new Error("Linear did not return an authorization code");
  const grant = await exchangeLinearCode({
    clientId: transaction.clientId,
    code,
    verifier: transaction.verifier,
    redirectUri: transaction.redirectUri,
  });
  await saveLinearConsent(id, transaction, grant);
  const next = transaction.actor === "app" ? "user" : "app";
  const latest = linearConfiguration(id);
  const runtime = readLinearConnector(id);
  if (linearActorNeedsConsent(runtime, latest.options, next)) {
    await beginLinearAuthorization(id, next);
    return null;
  }
  await configureLinearWebhooks(id);
  if (
    readLinearConnector(id)?.recovery &&
    readLinearConnector(id)?.app?.needsReauth
  ) {
    await beginLinearAuthorization(id, "app");
    return latest.options.appScopes.length === 0
      ? requireLinearConnection(id)
      : null;
  }
  return requireLinearConnection(id);
}
const completing = new Map<string, ReturnType<typeof finish>>();
export function finishLinearAuthorization(
  search: string,
): ReturnType<typeof finish> {
  const held = completing.get(search);
  if (held) return held;
  const result = finish(search);
  completing.set(search, result);
  void result.finally(() => completing.delete(search)).catch(() => undefined);
  return result;
}
