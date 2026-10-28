import {
  configureNativeCatalogConfiguration,
  nativeCatalogConfiguration,
  nativeCatalogConfigurationCleanupAdapter,
  readNativeCatalogConfiguration,
  verifyNativeCatalogConfiguration,
} from "@opensesame/app-core/lib/native-catalog-configuration.js";
import { bindNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-binding.js";
import { registerNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { captureNativeProviderAuthority } from "@opensesame/app-core/lib/native-connector-transport.js";
import type { Activation } from "../activation.js";

export function bindNativeCatalogConfigurationRuntime(
  activation: Activation,
): void {
  const authority = captureNativeProviderAuthority();
  const driver = bindNativeConnectorDriver(
    {
      supports: (providerId) => nativeCatalogConfiguration(providerId) !== null,
      configure: (input) =>
        configureNativeCatalogConfiguration(input, authority.capture()),
      verify: (connectionId) =>
        verifyNativeCatalogConfiguration(connectionId, authority.capture()),
      invoke: (connectionId, operation, input) => {
        if (operation !== "provider.read")
          throw new Error("Select local configuration review");
        return readNativeCatalogConfiguration(
          connectionId,
          input,
          authority.capture(),
        );
      },
      cleanup: nativeCatalogConfigurationCleanupAdapter,
    },
    authority,
  );
  activation.onDispose(registerNativeConnectorDriver("native-local", driver));
}
