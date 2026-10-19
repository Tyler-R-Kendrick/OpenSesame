/** Owned real TLS protocol fixtures use one finite carrier boundary double; never WASM evidence. */
import { vi } from "vitest";
import { captureNativeAuthorizationTransport } from "./native-authorization-transport.js";
import {
  bindNativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import type { NativeOAuthClientOwner } from "./native-oauth-client-config.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";
export function captureOAuthCarrier(
  owner: NativeOAuthClientOwner,
  origin: string,
) {
  const original = owner.transport;
  const allowed = new Set([origin]);
  const authorization = new AbortController();
  let routeCurrent = true;
  const capture = vi.fn(() => ({
    ...original,
    supportsNativeOrigin: (value: string) => {
      original.assertCurrent();
      return routeCurrent && allowed.has(value);
    },
  }));
  const releaseTransport = bindNativeProviderTransport({
    ...original,
    capture,
  });
  const releaseBrowser = bindNativeOAuthBrowserPort({
    redirectUri: owner.redirectUri,
    navigate() {},
    scrubCallback() {},
    captureAuthorizationGuard: () => () =>
      authorization.signal.throwIfAborted(),
  });
  const transport = captureNativeAuthorizationTransport(
    nativeProviderTransport(),
  );
  return {
    owner: { ...owner, transport },
    capture,
    allowed,
    authorization,
    sourceSignal: original.signal,
    withdrawRoute: () => {
      routeCurrent = false;
    },
    close: () => {
      releaseBrowser();
      releaseTransport();
    },
  };
}
export async function nativeOAuthCarrierFixture() {
  const f = await nativeOAuthClientFixture("client_secret_basic");
  const captured = captureOAuthCarrier(
    f.owner,
    new URL(f.input.parameters.token_endpoint ?? "").origin,
  );
  return {
    ...f,
    ...captured,
    input: { ...f.input, providerId: "resend" },
    close: async () => {
      captured.close();
      await f.close();
    },
  };
}
