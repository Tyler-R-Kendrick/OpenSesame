import { connectPlans } from "@opensesame/app-core/lib/connect-plan.js";
/** One captured provider cleanup dispatches to the obligation's original native method. */
import { CATALOG_ALIASES } from "@opensesame/app-core/lib/connector-catalog.generated.js";
import { catalogProviders } from "@opensesame/app-core/lib/connector-catalog.js";
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
import { captureNativeProviderAuthority } from "@opensesame/app-core/lib/native-connector-transport.js";
import { readSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import type { Activation } from "../activation.js";

const METHODS: readonly NativeMethod[] = [
  "api-key",
  "oauth",
  "oidc",
  "mcp",
  "native-local",
];

export function bindNativeCleanupRuntime(
  activation: Activation,
  extraProviderIds: readonly string[] = [],
): void {
  const transport = captureNativeProviderAuthority();
  const ids = new Set([
    ...connectPlans().map((plan) => plan.id),
    ...catalogProviders().map((provider) => provider.id),
    ...Object.keys(CATALOG_ALIASES),
    ...extraProviderIds,
  ]);
  for (const providerId of ids) {
    const legacy =
      providerId === "linear" ? deviceProviderRevokers.linear : undefined;
    if (legacy) deviceProviderRevokers.linear = undefined;
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
        capture: (connectionId) => {
          transport.assertCurrent();
          const record = loadNativeConnectorRecord(connectionId);
          if (!record || record.configuration.providerId !== providerId)
            throw new Error("Provider cleanup belongs to another connection");
          return (
            driver(record.configuration.method).cleanup.capture?.(
              connectionId,
            ) ?? transport.capture()
          );
        },
        prepare: async (connectionId, original) => {
          transport.assertCurrent();
          const record = loadNativeConnectorRecord(connectionId);
          if (!record || record.configuration.providerId !== providerId)
            throw new Error("Provider cleanup belongs to another connection");
          const prepare = driver(record.configuration.method).cleanup.prepare;
          if (original) await prepare?.(connectionId, original);
          else await prepare?.(connectionId);
          transport.assertCurrent();
        },
        finalize: async (connectionId, original) => {
          transport.assertCurrent();
          const record = loadNativeConnectorRecord(connectionId);
          if (!record || record.configuration.providerId !== providerId)
            throw new Error("Provider cleanup belongs to another connection");
          const finalize = driver(record.configuration.method).cleanup.finalize;
          if (original) await finalize?.(connectionId, original);
          else await finalize?.(connectionId);
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
    const previous = legacy ?? deviceProviderRevokers[providerId];
    const revoke = async (id: string) => {
      transport.assertCurrent();
      if (legacy && readSelfHostedConnector(id)) {
        await legacy(id);
        return;
      }
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
