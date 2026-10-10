import { nativeBrowserOAuthClientMetadataUrl } from "./native-browser-oauth-cimd.js";
import {
  browserOAuthClassification,
  browserOAuthEndpoints,
  browserOAuthScopes,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import { assertNativeBrowserOAuthPolicy } from "./native-browser-policy.js";
/** Public configuration is persisted separately from issued provider grants. */
import type { NativeDriverInput } from "./native-connector-drivers.js";
import {
  type NativeConfiguration,
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  loadNativeConnectorRecord,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import { nativeProviderTransport } from "./native-connector-transport.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

async function oauthFingerprint(
  configuration: NativeConfiguration,
): Promise<string> {
  const profile = requiredBrowserOAuthProfile(configuration.providerId);
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      providerId: profile.id,
      method: "oauth",
      clientId: configuration.clientId,
      endpoints: browserOAuthEndpoints(profile, configuration),
      scopes: configuration.requestedScopes,
      integrationId: configuration.parameters.integration_id,
      targetIds: configuration.targetIds,
    }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
function oauthConfiguration(input: NativeDriverInput): NativeConfiguration {
  const profile = requiredBrowserOAuthProfile(input.providerId);
  const { client_id: suppliedClientId, ...parameters } = input.parameters;
  const clientId =
    profile.mode === "cimd"
      ? nativeBrowserOAuthClientMetadataUrl()
      : (suppliedClientId?.trim() ?? "");
  if (
    profile.mode === "cimd" &&
    suppliedClientId &&
    suppliedClientId !== clientId
  )
    throw new Error("Use this deployment's public client metadata URL");
  if (
    input.method !== "oauth" ||
    Object.keys(input.credentials).length ||
    (!clientId && profile.mode !== "openrouter-key")
  )
    throw new Error(
      "Register a public browser client; confidential credentials are not supported",
    );
  if (
    Object.keys(parameters).some(
      (name) => !profile.publicParameters.includes(name),
    )
  )
    throw new Error("Unknown browser provider parameter");
  if (Object.keys(input.requestedScopes).some((actor) => actor !== "user"))
    throw new Error("This provider supports delegated user permissions only");
  const configuration: NativeConfiguration = {
    version: 1,
    providerId: input.providerId,
    method: "oauth",
    displayName: input.displayName.trim(),
    icon: input.icon ?? "",
    parameters,
    clientId: clientId || undefined,
    requestedScopes: input.requestedScopes,
    targetIds: input.targetIds,
    fingerprint: "0".repeat(64),
  };
  configuration.requestedScopes = {
    user: browserOAuthScopes(profile, configuration, "user"),
  };
  return configuration;
}
function existingConfiguration(
  input: NativeDriverInput,
  configuration: NativeConfiguration,
): NativeConnectorRecord | null {
  const saved = input.connectionId
    ? loadNativeConnectorRecord(input.connectionId)
    : null;
  if (
    input.connectionId &&
    (!saved ||
      saved.configuration.providerId !== input.providerId ||
      saved.revision !== input.revision)
  )
    throw new Error("Connector changed; reload before saving");
  if (saved && saved.configuration.method !== "oauth")
    throw new Error(
      "Create a separate connector for a different authentication method",
    );
  if (saved && saved.configuration.fingerprint !== configuration.fingerprint)
    assertNoAuthorization(saved);
  return saved;
}
function assertNoAuthorization(saved: NativeConnectorRecord): void {
  if (
    Object.keys(saved.privateState.grants).length ||
    Object.keys(saved.privateState.pending).length ||
    saved.privateState.recovery.length
  )
    throw new Error(
      "Finish provider authorization cleanup before changing this connector binding",
    );
}
export async function configureNativeBrowserOAuthConnector(
  input: NativeDriverInput,
) {
  assertNativeBrowserOAuthPolicy(input.providerId);
  const transport = nativeProviderTransport();
  const configuration = oauthConfiguration(input);
  configuration.fingerprint = await oauthFingerprint(configuration);
  transport.assertCurrent();
  const saved = existingConfiguration(input, configuration);
  const classification = browserOAuthClassification(configuration);
  if (!saved)
    return saveNativeConnector(
      {
        connectionId: `devconn_${crypto.randomUUID()}`,
        configuration,
        runtime: emptyNativeRuntime(),
        privateState: emptyNativePrivate(),
      },
      classification,
    );
  return updateNativeConnector(
    saved.connectionId,
    nativeOAuthGuard(saved),
    classification,
    (record) => {
      transport.assertCurrent();
      record.configuration = configuration;
      return record;
    },
  );
}
