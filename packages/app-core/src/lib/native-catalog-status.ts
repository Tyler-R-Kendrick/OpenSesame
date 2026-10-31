import type { Provider } from "./connections.js";
import { nativeCatalogConfigurationContract } from "./native-catalog-contract.js";
import type { NativeMethod } from "./native-connector-schema.js";

export function nativeLocalCatalogConfiguration(
  provider: Provider,
  method?: NativeMethod,
): boolean {
  return (
    method === "native-local" &&
    nativeCatalogConfigurationContract(provider) !== null
  );
}
