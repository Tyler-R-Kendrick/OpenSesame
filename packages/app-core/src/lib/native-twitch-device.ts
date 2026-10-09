import { captureNativeAuthorizationTransport } from "./native-authorization-transport.js";
import { retainAndVerifyNativeBrowserToken } from "./native-browser-oauth-finish.js";
/** Public Twitch clients authenticate in their own consent window and poll a finite device request. */
import {
  browserOAuthScopes,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import { assertNativeBrowserOAuthPolicy } from "./native-browser-policy.js";
import { retryNativeConnectorCleanup } from "./native-connector-lifecycle.js";
import type { NativePending } from "./native-connector-schema.js";
import { loadNativeConnectorRecord } from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import {
  type NativeOAuthDeviceConsent,
  nativeOAuthBrowserPort,
} from "./native-oauth-browser-port.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  markNativeOAuthMutationInFlight,
  nativeOAuthGuard,
} from "./native-oauth-session.js";
import {
  pollNativeTwitchDevice,
  requestNativeTwitchDevice,
} from "./native-twitch-device-http.js";
import {
  assertNativeTwitchPolling,
  finishNativeTwitchPolling,
  requireNativeTwitchDevice,
  sealNativeTwitchDevice,
} from "./native-twitch-device-state.js";

export type NativeTwitchDeviceWait = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;
export async function waitNativeTwitchDevice(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new NativeOAuthError("denied");
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new NativeOAuthError("denied"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
async function pollUntilAuthorized(
  id: string,
  pending: NativePending,
  interval: number,
  consent: NativeOAuthDeviceConsent,
  transport: NativeProviderTransport,
  wait: NativeTwitchDeviceWait,
) {
  let delay = interval * 1000;
  let waited = 0;
  const lifetime = pending.expiresAt - pending.createdAt;
  for (;;) {
    await assertNativeTwitchPolling(id, pending, transport);
    if (consent.signal.aborted) throw new NativeOAuthError("denied");
    const remaining = Math.min(
      pending.expiresAt - Date.now(),
      lifetime - waited,
    );
    if (remaining <= 0) throw new NativeOAuthError("expired");
    const duration = Math.min(delay, remaining);
    await wait(duration, consent.signal);
    waited += duration;
    await assertNativeTwitchPolling(id, pending, transport);
    if (consent.signal.aborted) throw new NativeOAuthError("denied");
    let reply: Awaited<ReturnType<typeof pollNativeTwitchDevice>>;
    try {
      reply = await pollNativeTwitchDevice(
        pending.clientId ?? "",
        pending.scopes,
        JSON.parse(pending.verifier),
        transport,
      );
    } catch (error) {
      const unknown =
        !(error instanceof NativeOAuthError) ||
        !["expired", "denied"].includes(error.code);
      await finishNativeTwitchPolling(id, pending, unknown);
      throw error;
    }
    if (reply.kind === "slow-down") delay += 5000;
    if (reply.kind !== "token") continue;
    const fenced = {
      ...transport,
      assertCurrent: () => {
        transport.assertCurrent();
        if (consent.signal.aborted || Date.now() >= pending.expiresAt)
          throw new NativeOAuthError("expired");
      },
    };
    await retainAndVerifyNativeBrowserToken(
      id,
      `oauth:${pending.state}`,
      pending,
      reply.token,
      fenced,
    );
    consent.close();
    return;
  }
}
export async function beginNativeTwitchDeviceAuthorization(
  id: string,
  actor = "user",
  wait: NativeTwitchDeviceWait = waitNativeTwitchDevice,
): Promise<void> {
  const record = requireNativeTwitchDevice(id);
  assertNativeBrowserOAuthPolicy("twitch");
  if (
    actor !== "user" ||
    Object.keys(record.privateState.pending).length ||
    record.privateState.recovery.length
  )
    throw new NativeOAuthError("cleanup");
  const browser = nativeOAuthBrowserPort();
  if (!browser.deviceConsent)
    throw new Error("This browser cannot display device authorization");
  const transport = captureNativeAuthorizationTransport(
    nativeProviderTransport(),
  );
  const scopes = browserOAuthScopes(
    requiredBrowserOAuthProfile("twitch"),
    record.configuration,
    actor,
  );
  const challenge = await requestNativeTwitchDevice(
    record.configuration.clientId ?? "",
    scopes,
    transport,
  );
  const pending = await sealNativeTwitchDevice(
    id,
    challenge,
    browser.redirectUri,
    scopes,
    nativeOAuthGuard(record),
    transport,
  );
  const finishMutation = markNativeOAuthMutationInFlight(
    id,
    `oauth:${pending.state}`,
  );
  let consent: NativeOAuthDeviceConsent | null = null;
  try {
    consent = browser.deviceConsent({
      verificationUri: challenge.verification_uri,
      userCode: challenge.user_code,
      state: pending.state,
      expiresAt: pending.expiresAt,
    });
    await pollUntilAuthorized(
      id,
      pending,
      challenge.interval,
      consent,
      transport,
      wait,
    );
  } catch (error) {
    await finishNativeTwitchPolling(id, pending, false);
    throw error;
  } finally {
    consent?.close();
    finishMutation();
    const current = loadNativeConnectorRecord(id);
    if (
      current?.privateState.recovery.some(
        (entry) => entry.id === `oauth:${pending.state}`,
      )
    )
      await retryNativeConnectorCleanup(id).catch(() => undefined);
  }
}
