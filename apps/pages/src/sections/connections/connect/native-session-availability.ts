import { nativeGoogleBrowserAvailable } from "@opensesame/app-core/browser/native-google-oauth.js";
import { nativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import {
  hasNativeConnectorDriver,
  nativeConnectorWithdrawn,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { supportsNativeOAuthResource } from "../../../modules/connectors.external/native-oauth-resource-runtime.js";

export function mcpInactiveReason(): string | undefined {
  return vaultStore.isGenuineSession()
    ? undefined
    : "Open your own vault to connect this provider. Guest sessions do not store provider credentials.";
}

export function nativeOAuthAvailability(providerId: string) {
  const genuine = vaultStore.isGenuineSession();
  const googleBlocked =
    providerId === "google" && !nativeGoogleBrowserAvailable();
  return {
    registeredAvailable:
      genuine &&
      hasNativeConnectorDriver("oauth", providerId) &&
      supportsNativeOAuthResource(providerId),
    available:
      genuine &&
      supportsNativeOAuthResource(providerId) &&
      !nativeConnectorWithdrawn("oauth") &&
      !googleBlocked,
    reason: !genuine
      ? mcpInactiveReason()
      : googleBlocked
        ? "Google consent is unavailable under this deployment's isolation policy."
        : undefined,
    profile: nativeBrowserOAuthProfile(providerId) ?? undefined,
  };
}
