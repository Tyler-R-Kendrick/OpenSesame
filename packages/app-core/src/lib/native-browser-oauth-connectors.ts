import { beginNativeGoogleAuthorization } from "./native-browser-google-consent.js";
import { nativeBrowserOAuthCleanup } from "./native-browser-oauth-cleanup.js";
import { beginNativeBrowserAuthorization as beginPkce } from "./native-browser-oauth-consent.js";
import {
  browserOAuthClassification,
  browserOAuthScopes,
  nativeBrowserOAuthProfile,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import { refreshNativeBrowserAuthorization } from "./native-browser-oauth-refresh.js";
import {
  type NativeOAuthVerification,
  verifyNativeBrowserOAuth,
} from "./native-browser-oauth-verify.js";
import { assertNativeBrowserOAuthPolicy } from "./native-browser-policy.js";
import { listNativeCodebergRepositories } from "./native-codeberg-provider.js";
/** Provider-specific public authorization implements the native driver contract. */
import type { NativeConnectorDriver } from "./native-connector-drivers.js";
import type { NativeGrant, NativePending } from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { beginNativeDiscordAuthorization } from "./native-discord-consent.js";
import { listNativeDiscordGuilds } from "./native-discord-operations.js";
import { nativeOAuthRedirectUri } from "./native-oauth-browser-port.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import { beginNativeTwitchDeviceAuthorization } from "./native-twitch-device.js";
export { configureNativeBrowserOAuthConnector } from "./native-browser-oauth-config.js";
export { finishNativeBrowserAuthorization } from "./native-browser-oauth-finish.js";
import { configureNativeBrowserOAuthConnector } from "./native-browser-oauth-config.js";

export async function beginNativeBrowserAuthorization(
  id: string,
  actor = "user",
): Promise<void> {
  const record = requireNativeOAuthRecord(id);
  assertNativeBrowserOAuthPolicy(record.configuration.providerId);
  if (record.configuration.providerId === "discord")
    return beginNativeDiscordAuthorization(id, actor);
  if (record.configuration.providerId === "twitch")
    return beginNativeTwitchDeviceAuthorization(id, actor);
  if (record.configuration.providerId === "google")
    return beginNativeGoogleAuthorization(id, actor);
  return beginPkce(id, actor);
}
function persistVerification(
  record: NativeConnectorRecord,
  grant: NativeGrant,
  verified: NativeOAuthVerification,
  transport: NativeProviderTransport,
) {
  return updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      transport.assertCurrent();
      const verifiedAt = Math.max(
        Date.now(),
        (current.runtime.verifiedAt ?? 0) + 1,
      );
      current.privateState.verification = {
        fingerprint: current.configuration.fingerprint,
        verifiedAt,
        kind: "provider",
      };
      current.runtime = {
        verifiedAt,
        identity: verified.identity,
        targets: verified.targets,
        grants: [
          {
            actor: "user",
            label: "Authorized user",
            permissionState:
              grant.scopes === null ? "provider-managed" : "known",
            grantedScopes: grant.scopes ?? [],
            expiresAt: grant.expiresAt,
            needsReauth: false,
          },
        ],
      };
      return current;
    },
  );
}
export async function verifyNativeBrowserOAuthConnector(id: string) {
  const transport = nativeProviderTransport();
  const redirectUri = nativeOAuthRedirectUri();
  let record = requireNativeOAuthRecord(id);
  assertNativeBrowserOAuthPolicy(record.configuration.providerId);
  if (
    record.configuration.method !== "oauth" ||
    record.privateState.recovery.length ||
    Object.keys(record.privateState.pending).length
  )
    throw new NativeOAuthError("cleanup");
  let grant = record.privateState.grants.user;
  if (!grant) throw new NativeOAuthError("expired");
  if (grant.expiresAt !== null && grant.expiresAt <= Date.now()) {
    await refreshNativeBrowserAuthorization(record, transport);
    record = requireNativeOAuthRecord(id);
    grant = record.privateState.grants.user;
    if (!grant) throw new NativeOAuthError("expired");
  }
  const profile = requiredBrowserOAuthProfile(record.configuration.providerId);
  const pending: NativePending = {
    ...grant,
    state: "0".repeat(43),
    verifier: "0".repeat(43),
    redirectUri,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    scopes: browserOAuthScopes(profile, record.configuration, "user"),
  };
  const verified = await verifyNativeBrowserOAuth(
    record.configuration,
    pending,
    {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
      scopes: grant.scopes,
      protocolValid: true,
    },
    transport,
    record.runtime.identity ?? undefined,
  ).catch(async (error: Error) => {
    if (
      error instanceof NativeOAuthError &&
      ["expired", "scope"].includes(error.code)
    ) {
      await updateNativeConnector(
        id,
        nativeOAuthGuard(record),
        browserOAuthClassification(record.configuration),
        (current) => {
          current.privateState.verification = null;
          current.runtime.verifiedAt = null;
          current.runtime.grants = current.runtime.grants.map((metadata) => ({
            ...metadata,
            needsReauth: true,
          }));
          return current;
        },
      );
    }
    throw error;
  });
  if (
    record.runtime.identity &&
    record.runtime.identity.id !== verified.identity.id
  )
    throw new NativeOAuthError("provider");
  return persistVerification(record, grant, verified, transport);
}
function assertNativeOAuthOperationProvider(
  providerId: string,
  operationId: string,
): void {
  if (operationId === "provider.repositories.read" && providerId !== "codeberg")
    throw new NativeOAuthError("provider");
  if (operationId === "provider.guilds.read" && providerId !== "discord")
    throw new NativeOAuthError("provider");
}
export async function invokeNativeBrowserOAuthConnector(
  id: string,
  operationId: string,
  input: Record<string, string> = {},
) {
  if (
    ![
      "provider.read",
      "provider.repositories.read",
      "provider.guilds.read",
    ].includes(operationId) ||
    Object.keys(input).length
  )
    throw new Error("Select a supported provider operation");
  const held = readNativeConnector(id);
  if (!held || !["connected", "reauthorize"].includes(held.status))
    throw new NativeOAuthError("expired");
  assertNativeOAuthOperationProvider(held.providerId, operationId);
  const view = await verifyNativeBrowserOAuthConnector(id);
  if (operationId === "provider.guilds.read") {
    const grant = requireNativeOAuthRecord(id).privateState.grants.user;
    if (!grant) throw new NativeOAuthError("expired");
    return listNativeDiscordGuilds(grant, nativeProviderTransport());
  }
  if (operationId === "provider.repositories.read") {
    const grant = requireNativeOAuthRecord(id).privateState.grants.user;
    if (!grant) throw new NativeOAuthError("expired");
    return listNativeCodebergRepositories(grant, nativeProviderTransport());
  }
  return {
    label: view.identity?.label ?? "Provider account verified",
    items: [],
  };
}
export function createNativeBrowserOAuthDriver(): NativeConnectorDriver {
  return {
    supports: (id) => nativeBrowserOAuthProfile(id) !== null,
    cleanup: nativeBrowserOAuthCleanup,
    configure: configureNativeBrowserOAuthConnector,
    authorize: beginNativeBrowserAuthorization,
    verify: verifyNativeBrowserOAuthConnector,
    invoke: invokeNativeBrowserOAuthConnector,
  };
}
