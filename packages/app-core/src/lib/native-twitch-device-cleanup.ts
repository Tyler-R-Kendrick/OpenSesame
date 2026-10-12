import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import { browserOAuthClassification } from "./native-browser-oauth-profile.js";
/** A completed device request without an observed token has no credential to revoke. */
import type {
  NativeCleanupContext,
  NativeCleanupOutcome,
} from "./native-connector-lifecycle.js";
import {
  type NativeGrant,
  type NativeRecovery,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeOAuthHttp } from "./native-oauth-http.js";
import {
  nativeOAuthGuard,
  nativeOAuthMutationInFlight,
} from "./native-oauth-session.js";

export async function cleanupNativeTwitchDevice(
  obligation: NativeRecovery,
  context: NativeCleanupContext,
  transport: NativeProviderTransport,
): Promise<NativeCleanupOutcome> {
  assertTwitchCleanupBinding(obligation, context);
  assertTwitchCleanupSettled(obligation, context);
  if (obligation.grant) {
    const grant = obligation.grant;
    if (
      grant.kind !== "oauth" ||
      !grant.clientId ||
      grant.clientId !== context.configuration.clientId
    )
      throw new NativeOAuthError("cleanup");
    const reply = await nativeOAuthHttp(
      "https://id.twitch.tv/oauth2/revoke",
      new URLSearchParams({
        client_id: grant.clientId,
        token: grant.accessToken,
      }),
      transport,
      undefined,
      false,
    );
    if (reply.status !== 200 && reply.status !== 400)
      throw new NativeOAuthError("cleanup");
    await proveNativeTwitchAccessRevoked(grant.accessToken, transport);
    await clearRevokedNativeTwitchGrant(context.connectionId, grant);
    return "local-credential-forgotten";
  }
  if (
    obligation.kind !== "revoke" ||
    !["device-unobserved", "device-poll"].includes(
      obligation.credentials?.phase ?? "",
    )
  )
    throw new NativeOAuthError("cleanup");
  return "local-credential-forgotten";
}
function assertTwitchCleanupBinding(
  obligation: NativeRecovery,
  context: NativeCleanupContext,
) {
  if (
    context.configuration.providerId !== "twitch" ||
    context.configuration.method !== "oauth" ||
    obligation.providerId !== "twitch" ||
    obligation.actor !== "user" ||
    obligation.kind !== "revoke" ||
    obligation.fingerprint !== context.configuration.fingerprint
  )
    throw new NativeOAuthError("cleanup");
  const grant = obligation.grant;
  if (
    grant &&
    (grant.providerId !== obligation.providerId ||
      grant.actor !== obligation.actor ||
      grant.fingerprint !== obligation.fingerprint ||
      grant.targetId !== obligation.targetId)
  )
    throw new NativeOAuthError("cleanup");
}
async function clearRevokedNativeTwitchGrant(id: string, grant: NativeGrant) {
  const record = loadNativeConnectorRecord(id);
  if (
    !record ||
    record.privateState.grants[grant.actor]?.accessToken !==
      grant.accessToken ||
    record.privateState.grants[grant.actor]?.fingerprint !== grant.fingerprint
  )
    return;
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      current.privateState.grants = Object.fromEntries(
        Object.entries(current.privateState.grants).filter(
          ([actor]) => actor !== grant.actor,
        ),
      );
      current.privateState.verification = null;
      current.runtime = emptyNativeRuntime();
      return current;
    },
  );
}
async function proveNativeTwitchAccessRevoked(
  token: string,
  transport: NativeProviderTransport,
) {
  try {
    await nativeApiHttp(
      {
        url: "https://id.twitch.tv/oauth2/validate",
        method: "GET",
        headers: new Headers({ authorization: `OAuth ${token}` }),
      },
      transport,
    );
  } catch (error) {
    if (error instanceof NativeApiError && error.status === 401) return;
    throw new NativeOAuthError("cleanup");
  }
  throw new NativeOAuthError("cleanup");
}

function assertTwitchCleanupSettled(
  obligation: NativeRecovery,
  context: NativeCleanupContext,
) {
  const phase = obligation.credentials?.phase ?? "";
  const settledGrant = !!obligation.grant && phase === "verify";
  const parentId = obligation.credentials?.device_parent;
  if (
    (!settledGrant &&
      nativeOAuthMutationInFlight(context.connectionId, obligation.id)) ||
    (parentId && nativeOAuthMutationInFlight(context.connectionId, parentId)) ||
    (["device-poll", "refresh"].includes(phase) &&
      Number(obligation.credentials?.deadline) > Date.now())
  )
    throw new NativeOAuthError("cleanup");
}
