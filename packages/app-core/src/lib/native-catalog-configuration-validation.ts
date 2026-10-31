import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import type { NativeCatalogConfiguration } from "./native-catalog-contract.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import {
  validateGoogleWalletKey,
  validateGoogleWalletPublic,
} from "./native-google-wallet-configuration.js";

export async function validateNativeCatalogValues(
  contract: NativeCatalogConfiguration,
  input: NativeDriverInput,
  parameters: Record<string, string>,
  credentials: Record<string, string>,
): Promise<void> {
  const comparableCredentials = Object.fromEntries(
    Object.entries(credentials).map(([name, value]) => [name, value.trim()]),
  );
  safeProviderText(input.displayName, comparableCredentials);
  safeNativeConnectorIcon(input.icon ?? "", comparableCredentials);
  for (const value of Object.values(parameters))
    safeProviderText(value, comparableCredentials);
  if (contract.provider.id === "google-wallet") {
    validateGoogleWalletPublic(parameters);
    await validateGoogleWalletKey(credentials.service_account_key ?? "");
  }
}
