/** One captured provider cleanup dispatches to the obligation's original native method. */
import { connectPlans } from "@opensesame/app-core/lib/connect-plan.js";
import { deviceProviderRevokers } from "@opensesame/app-core/lib/device-connectors.js";
import {
  type NativeConnectorDriver,
  hasNativeConnectorDriver,
  nativeConnectorDriver,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
} from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import type { NativeMethod } from "@opensesame/app-core/lib/native-connector-schema.js";
import { loadNativeConnectorRecord } from "@opensesame/app-core/lib/native-connector-store.js";
import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import type { Activation } from "../activation.js";

const METHODS: readonly NativeMethod[] = [
  "api-key",
  "oauth",
  "mcp",
  "native-local",
];

export function bindNativeCleanupRuntime(
  activation: Activation,
  extraProviderIds: readonly string[] = [],
): void {
  const transport = nativeProviderTransport();
  const ids = new Set([
    ...connectPlans().map((plan) => plan.id),
    ...extraProviderIds,
  ]);
  for (const providerId of ids) {
    if (providerId === "linear") continue;
    const captured = new Map<NativeMethod, NativeConnectorDriver>();
    for (const method of METHODS) {
      if (hasNativeConnectorDriver(method, providerId))
        captured.set(method, nativeConnectorDriver(method, providerId));
    }
    if (!captured.size) continue;
    const driver = (method: NativeMethod) => {
      transport.assertCurrent();
      const selected = captured.get(method);
      if (!selected)
        throw new Error("This provider cleanup method is unavailable");
      return selected;
    };
    activation.onDispose(
      registerNativeProviderCleanup(providerId, {
        prepare: async (connectionId) => {
          transport.assertCurrent();
          const record = loadNativeConnectorRecord(connectionId);
          if (!record || record.configuration.providerId !== providerId)
            throw new Error("Provider cleanup belongs to another connection");
          await driver(record.configuration.method).cleanup.prepare?.(
            connectionId,
          );
          transport.assertCurrent();
        },
        credentialSlots: (configuration, grant) => {
          const slots =
            driver(grant?.kind ?? configuration.method).cleanup
              .credentialSlots ?? [];
          return "call" in slots ? slots(configuration, grant) : slots;
        },
        classification: (configuration) =>
          driver(configuration.method).cleanup.classification(configuration),
        cleanup: async (obligation, context) => {
          const method = obligation.grant?.kind ?? context.configuration.method;
          const result = await driver(method).cleanup.cleanup(
            obligation,
            context,
          );
          transport.assertCurrent();
          return result;
        },
      }),
    );
    const previous = deviceProviderRevokers[providerId];
    const revoke = async (id: string) => {
      transport.assertCurrent();
      const record = loadNativeConnectorRecord(id);
      if (!record || record.configuration.providerId !== providerId)
        throw new Error("Provider cleanup belongs to another connection");
      await removeNativeConnectorWithCleanup(id);
      transport.assertCurrent();
    };
    deviceProviderRevokers[providerId] = revoke;
    activation.onDispose(() => {
      if (deviceProviderRevokers[providerId] === revoke)
        deviceProviderRevokers[providerId] = previous;
    });
  }
}
