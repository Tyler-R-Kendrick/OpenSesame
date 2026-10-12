/** The provider device code is sealed; only its short user code is shown during consent. */
import { randomString } from "@opensesame/sdk-browser";
import { browserOAuthClassification } from "./native-browser-oauth-profile.js";
import type { NativePending } from "./native-connector-schema.js";
import {
  assertNativeConnectorRevision,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import type { NativeTwitchDeviceChallenge } from "./native-twitch-device-http.js";

export function requireNativeTwitchDevice(id: string) {
  const record = requireNativeOAuthRecord(id);
  if (
    record.configuration.providerId !== "twitch" ||
    record.configuration.method !== "oauth" ||
    !record.configuration.clientId
  )
    throw new NativeOAuthError("provider");
  return record;
}
export async function sealNativeTwitchDevice(
  id: string,
  challenge: NativeTwitchDeviceChallenge,
  redirectUri: string,
  scopes: string[],
  expected: { revision: number; fingerprint: string },
  transport: NativeProviderTransport,
): Promise<NativePending> {
  const record = requireNativeTwitchDevice(id);
  const now = Date.now();
  const pending: NativePending = {
    providerId: "twitch",
    actor: "user",
    fingerprint: record.configuration.fingerprint,
    targetId: record.runtime.identity?.id,
    clientId: record.configuration.clientId,
    issuer: "https://id.twitch.tv",
    endpoint: "https://id.twitch.tv/oauth2/token",
    state: randomString(32),
    verifier: JSON.stringify(challenge.device_code).padEnd(43, " "),
    redirectUri,
    createdAt: now,
    expiresAt: now + challenge.expires_in * 1000,
    scopes,
  };
  await updateNativeConnector(
    id,
    expected,
    browserOAuthClassification(record.configuration),
    (current) => {
      transport.assertCurrent();
      if (
        Object.keys(current.privateState.pending).length ||
        current.privateState.recovery.length
      )
        throw new NativeOAuthError("cleanup");
      current.privateState.pending.user = pending;
      current.privateState.verification = null;
      current.privateState.recovery.push({
        id: `oauth:${pending.state}`,
        kind: "revoke",
        providerId: "twitch",
        actor: "user",
        fingerprint: pending.fingerprint,
        targetId: pending.targetId ?? "twitch",
        issuer: pending.issuer,
        endpoint: pending.endpoint,
        clientId: pending.clientId,
        credentials: {
          phase: "device-poll",
          deadline: String(pending.expiresAt + 15_000),
          identity_id: record.runtime.identity?.id ?? "",
        },
      });
      return current;
    },
  );
  return pending;
}
export async function assertNativeTwitchPolling(
  id: string,
  pending: NativePending,
  transport: NativeProviderTransport,
) {
  transport.assertCurrent();
  const record = requireNativeTwitchDevice(id);
  await assertNativeConnectorRevision(id, nativeOAuthGuard(record));
  const actual = record.privateState.pending.user;
  if (
    !actual ||
    actual.state !== pending.state ||
    actual.fingerprint !== pending.fingerprint ||
    record.configuration.fingerprint !== pending.fingerprint
  )
    throw new NativeOAuthError("expired");
  if (pending.expiresAt <= Date.now()) throw new NativeOAuthError("expired");
}
export async function finishNativeTwitchPolling(
  id: string,
  pending: NativePending,
  unknownReply: boolean,
) {
  const record = requireNativeTwitchDevice(id);
  if (record.privateState.pending.user?.state !== pending.state) return;
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      const intent = current.privateState.recovery.find(
        (entry) => entry.id === `oauth:${pending.state}`,
      );
      current.privateState.pending = Object.fromEntries(
        Object.entries(current.privateState.pending).filter(
          ([actor, entry]) => actor !== "user" || entry.state !== pending.state,
        ),
      );
      if (intent?.grant) return current;
      if (unknownReply && intent) {
        intent.credentials = {
          ...intent.credentials,
          phase: "device-unobserved",
          deadline: "0",
        };
        current.configuration.parameters.authorization_outcome =
          "exchange-unobserved";
      } else
        current.privateState.recovery = current.privateState.recovery.filter(
          (entry) => entry.id !== `oauth:${pending.state}`,
        );
      return current;
    },
  );
}
