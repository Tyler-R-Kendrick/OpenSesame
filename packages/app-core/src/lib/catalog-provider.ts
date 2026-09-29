/**
 * Which bundled rows are connection brokers (ADR 0153).
 *
 * Settings draws provider tiles with Connections off, so this check cannot
 * live in the connector-guidance module that capability owns.
 */
import { isSettingsEncryptionKey } from "./capabilities.js";
import type { Provider } from "./connections.js";

/** Age, WebCrypto, sealed-local and passkeys are not catalog brokers. */
export function isConnectionCatalogProvider(
  provider: Pick<Provider, "id" | "autoConfigurable">,
): boolean {
  if (isSettingsEncryptionKey(provider.id)) return false;
  if (provider.id === "fido2") return false;
  return !provider.autoConfigurable;
}
