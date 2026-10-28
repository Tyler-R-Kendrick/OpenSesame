import { afterEach } from "vitest";
import { registerNativeProviderCleanup } from "./native-connector-lifecycle.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";
import { createNativeOAuthResourceDriver } from "./native-oauth-resource-driver.js";
import { localVaultSessionGuard } from "./secret-backends/local-vault-port.js";
import { vaultStore } from "./vault/store.js";

const closes: (() => Promise<void>)[] = [];
export const operations: Promise<unknown>[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  await Promise.allSettled(operations.splice(0));
});
export function deferCleanup(close: () => Promise<void>) {
  closes.push(close);
}

export async function setup() {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closes.push(f.close);
  let cancelled = false;
  const unbind = bindNativeOAuthBrowserPort({
    redirectUri: f.owner.redirectUri,
    navigate: () => {
      throw new Error("Unexpected navigation");
    },
    scrubCallback: () => {},
    authorize: async (url) => {
      if (cancelled) throw new Error("Operator dismissed consent");
      const target = new URL(url);
      f.state.challenge = target.searchParams.get("code_challenge") ?? "";
      return new URLSearchParams({
        native_state: target.searchParams.get("state") ?? "",
        native_code: "one-use-code",
      }).toString();
    },
  });
  closes.push(async () => unbind());
  let capturedSignal: AbortSignal | undefined;
  let captures = 0;
  let released = 0;
  const driver = createNativeOAuthResourceDriver({
    supports: (id) => id === f.input.providerId,
    capture: async (signal) => {
      signal?.throwIfAborted();
      capturedSignal = signal;
      const guard = localVaultSessionGuard(vaultStore);
      captures++;
      const base = f.owner.transport;
      const transport: NativeProviderTransport = {
        ...base,
        assertCurrent: () => {
          base.assertCurrent();
          guard.current();
        },
      };
      return {
        ...f.owner,
        transport,
        close: () => {
          guard.close();
          released++;
        },
      };
    },
  });
  const unregister = registerNativeProviderCleanup(
    f.input.providerId,
    driver.cleanup,
  );
  closes.push(async () => unregister());
  return {
    ...f,
    driver,
    cancel: () => {
      cancelled = true;
    },
    captureCounts: () => ({ captures, released }),
    capturedSignal: () => capturedSignal,
  };
}

export function authorize(f: Awaited<ReturnType<typeof setup>>, id: string) {
  if (!f.driver.authorize)
    throw new Error("Missing actual authorization driver");
  return f.driver.authorize(id);
}
