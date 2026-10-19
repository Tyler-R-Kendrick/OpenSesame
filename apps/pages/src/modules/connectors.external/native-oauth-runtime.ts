/** Public browser consent shares the same activation as provider HTTP operations. */
import {
  nativeGoogleBrowserAvailable,
  requestNativeGoogleToken,
} from "@opensesame/app-core/browser/native-google-oauth.js";
import { createNativeBrowserOAuthDriver } from "@opensesame/app-core/lib/native-browser-oauth-connectors.js";
import { bindNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-binding.js";
import {
  type NativeDriverInput,
  registerNativeConnectorDriver,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { captureNativeProviderAuthority } from "@opensesame/app-core/lib/native-connector-transport.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import type { Activation } from "../activation.js";
import { nativeAuthPopupRuntime } from "./native-auth-popup-runtime.js";
import { bindNativeMcpRuntime } from "./native-mcp-runtime.js";

export function nativeCallbackUrl(): string {
  return new URL(
    `${import.meta.env.BASE_URL}auth/native-connector.html`,
    window.location.origin,
  ).href;
}

export function bindNativeOAuthRuntime(activation: Activation): void {
  const transport = captureNativeProviderAuthority();
  activation.onDispose(
    bindNativeOAuthBrowserPort({
      redirectUri: nativeCallbackUrl(),
      ...nativeAuthPopupRuntime(
        activation,
        nativeCallbackUrl(),
        transport.assertCurrent,
      ),
      navigate: (url) => {
        transport.assertCurrent();
        window.location.assign(url);
      },
      scrubCallback: () => {
        const url = new URL(window.location.href);
        for (const key of [...url.searchParams.keys()]) {
          if (key.startsWith("native_")) url.searchParams.delete(key);
        }
        window.history.replaceState(null, "", url.href);
      },
      googleToken: requestNativeGoogleToken,
    }),
  );
  const oauth = createNativeBrowserOAuthDriver(transport);
  const browserOAuth = {
    ...oauth,
    configure: (input: NativeDriverInput) => {
      transport.assertCurrent();
      assertGoogleConsentAvailable(input.providerId);
      return oauth.configure(input);
    },
    authorize: (id: string, actor?: string) => {
      transport.assertCurrent();
      assertGoogleConsentAvailable(readNativeConnector(id)?.providerId ?? "");
      if (!oauth.authorize)
        throw new Error("Browser OAuth authorization is unavailable");
      return oauth.authorize(id, actor);
    },
  };
  activation.onDispose(
    registerNativeConnectorDriver(
      "oauth",
      bindNativeConnectorDriver(browserOAuth, transport),
    ),
  );
  bindNativeMcpRuntime(activation);
}

function assertGoogleConsentAvailable(providerId: string): void {
  if (providerId === "google" && !nativeGoogleBrowserAvailable())
    throw new Error(
      "Google popup authorization is unavailable under this deployment's browser isolation policy",
    );
}
