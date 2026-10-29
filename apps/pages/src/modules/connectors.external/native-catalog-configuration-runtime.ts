import {
  configureNativeCatalogConfiguration,
  nativeCatalogConfiguration,
  nativeCatalogConfigurationCleanupAdapter,
  readNativeCatalogConfiguration,
  verifyNativeCatalogConfiguration,
} from "@opensesame/app-core/lib/native-catalog-configuration.js";
import { bindNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-binding.js";
import { registerNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  type NativeProviderTransport,
  captureNativeProviderAuthority,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import type { Activation } from "../activation.js";
import { LeaseAbortedError, anySignal } from "../signals.js";

/** Fence a form-owned save: a retired form cannot publish a configuration. */
function ownedCatalogTransport(
  original: NativeProviderTransport,
  owner: { signal: AbortSignal; assertCurrent(): void },
): NativeProviderTransport {
  const caller = owner.signal;
  const assertOwner = owner.assertCurrent;
  const checkCaller = () => {
    if (owner.signal !== caller || owner.assertCurrent !== assertOwner)
      throw new LeaseAbortedError();
    assertOwner.call(owner);
  };
  checkCaller();
  caller.throwIfAborted();
  const signals = [caller];
  if (original.signal) signals.push(original.signal);
  const signal = anySignal(signals);
  const assertCurrent = () => {
    try {
      checkCaller();
      original.assertCurrent();
      signal.throwIfAborted();
      checkCaller();
    } catch {
      throw new LeaseAbortedError("This provider operation ended.");
    }
  };
  const transport = { ...original, signal, assertCurrent };
  assertCurrent();
  return transport;
}

export function bindNativeCatalogConfigurationRuntime(
  activation: Activation,
): void {
  const authority = captureNativeProviderAuthority();
  const driver = bindNativeConnectorDriver(
    {
      supports: (providerId) => nativeCatalogConfiguration(providerId) !== null,
      configure: (input) => {
        const { owner, ...draft } = input;
        const original = authority.capture();
        return configureNativeCatalogConfiguration(
          draft,
          owner ? ownedCatalogTransport(original, owner) : original,
        );
      },
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
