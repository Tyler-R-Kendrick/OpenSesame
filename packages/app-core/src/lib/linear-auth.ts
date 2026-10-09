/** Linear's public-client OAuth flow: S256, actor-bound state, verified workspace. */
import { env } from "../host.js";
import { page } from "../ports.js";
import { readDeviceSecrets } from "./device-connector-records.js";
import { kvDurability } from "./kv.js";
import { exchangeLinearCode } from "./linear-api.js";
import {
  clearLinearAuthorizationRequest,
  createLinearAuthorizationRequest,
  linearPopupCallback,
} from "./linear-auth-request.js";
import {
  type LinearAuthorizationReservation,
  reserveLinearAuthorizationWindow,
} from "./linear-auth-reservation.js";
import { saveLinearConsent } from "./linear-consent-save.js";
import { optionalNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
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
async function prepareLinearAuthorization(id: string, actor: LinearActor) {
  if (kvDurability() === "memory")
    throw new Error(
      "Linear OAuth requires durable browser storage; enable browser storage or use an API key",
    );
  const saved = linearConfiguration(id);
  if (saved.state.method !== "oauth" || !saved.state.oauth.clientId.trim())
    throw new Error("Enter the registered Linear OAuth client ID first");
  if (await finishCleanupOnly(id, actor)) return null;
  const deferred = actor === "app" && (await deferLinearWebhookCleanup(id));
  if (
    readLinearConnector(id)?.[actor] ||
    readDeviceSecrets()[id]?.[`linear_cleanup_${actor}`]
  ) {
    if (actor === "app" && !deferred) await removeLinearWebhook(id);
    await removeLinearActor(id, actor);
  }
  return createLinearAuthorizationRequest(id, actor, linearRedirectUri());
}
const authorizing = new Set<string>();
export async function beginLinearAuthorization(
  id: string,
  actor: LinearActor,
  held?: LinearAuthorizationReservation,
): Promise<void> {
  if (authorizing.has(id))
    throw new Error("Finish the current Linear sign-in first");
  authorizing.add(id);
  let reservation = held;
  let browser = held?.browser ?? null;
  let state: string | null = null;
  try {
    // This runs in the originating click, before durable writes or provider requests.
    reservation ??= reserveLinearAuthorizationWindow();
    browser = reservation.browser;
    const request = await prepareLinearAuthorization(id, actor);
    if (!request) return;
    state = request.pending.state;
    if (!browser?.authorize) {
      page().location.assign(request.url);
      return;
    }
    const callback = await browser.authorize(request.url, {
      state,
      expiresAt: request.pending.createdAt + MAX_AGE,
      redirectUri: request.pending.redirectUri,
    });
    await finishLinearAuthorization(linearPopupCallback(callback, state));
  } catch (error) {
    if (state && browser?.authorize)
      await clearLinearAuthorizationRequest(id, state);
    throw error;
  } finally {
    try {
      reservation?.release();
    } finally {
      authorizing.delete(id);
    }
  }
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
function popupConsentAvailable(): boolean {
  return Boolean(optionalNativeOAuthBrowserPort()?.authorize);
}
async function finish(search: string, assertCurrent?: () => void) {
  const params = callbackParameters(search);
  if (!params) return null;
  assertCurrent?.();
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
  assertCurrent?.();
  const grant = await exchangeLinearCode({
    clientId: transaction.clientId,
    code,
    verifier: transaction.verifier,
    redirectUri: transaction.redirectUri,
  });
  await saveLinearConsent(id, transaction, grant, assertCurrent);
  assertCurrent?.();
  return finishLinearSetup(id, transaction);
}
async function finishLinearSetup(id: string, transaction: PendingLinear) {
  const next = transaction.actor === "app" ? "user" : "app";
  const latest = linearConfiguration(id);
  const runtime = readLinearConnector(id);
  if (linearActorNeedsConsent(runtime, latest.options, next)) {
    // A second actor needs a fresh user click to open another consent window.
    if (popupConsentAvailable()) return requireLinearConnection(id);
    await beginLinearAuthorization(id, next);
    return null;
  }
  await configureLinearWebhooks(id);
  if (
    readLinearConnector(id)?.recovery &&
    readLinearConnector(id)?.app?.needsReauth
  ) {
    if (popupConsentAvailable()) return requireLinearConnection(id);
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
  const guard = optionalNativeOAuthBrowserPort()?.captureAuthorizationGuard?.();
  const result = finish(search, guard);
  completing.set(search, result);
  void result.finally(() => completing.delete(search)).catch(() => undefined);
  return result;
}
