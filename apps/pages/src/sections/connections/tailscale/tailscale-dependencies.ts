import {
  nativeOAuthBrowserPort,
  nativeOAuthRedirectUri,
  optionalNativeOAuthBrowserPort,
} from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { localVaultSessionGuard } from "@opensesame/app-core/lib/secret-backends/local-vault-port.js";
import {
  assertTailscaleAppCurrent,
  forgetTailscaleApp,
  hydrateTailscaleApps,
  openTailscaleApp,
  readTailscaleApp,
  saveTailscaleApp,
} from "@opensesame/app-core/lib/tailscale/store.js";
/** The browser shell supplies these ports; tests replace ports, not module identities. */
import { tailscaleTransport } from "@opensesame/app-core/lib/tailscale/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";

type VaultSession = {
  current: () => { tomb: string; guest: boolean };
  close: () => void;
};
export const tailscaleAppDependencies = {
  transport: tailscaleTransport,
  browser: nativeOAuthBrowserPort,
  optionalBrowser: optionalNativeOAuthBrowserPort,
  redirectUri: nativeOAuthRedirectUri,
  session: (): VaultSession => localVaultSessionGuard(vaultStore),
  onLock: (callback: () => void) => vaultStore.onLock(callback),
  onVaultChange: (callback: () => void) => vaultStore.subscribe(callback),
  hydrateTailscaleApps,
  readTailscaleApp,
  saveTailscaleApp,
  openTailscaleApp,
  forgetTailscaleApp,
  assertTailscaleAppCurrent,
};
