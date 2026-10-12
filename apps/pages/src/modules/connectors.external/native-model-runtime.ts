/** Only External connectors reads native authority and attaches model provider credentials. */
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  type HostedModelConnection,
  type HostedModelFence,
  bindHostedModelAuthority,
} from "@opensesame/app-core/lib/hosted-model-authority.js";
import { executeNativeApiRequest } from "@opensesame/app-core/lib/native-api-operations.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import type { Activation } from "../activation.js";
import { anySignal, runUnlessAborted } from "../signals.js";
function modelConnection(id: string): HostedModelConnection | null {
  const view = readNativeConnector(id);
  return view
    ? {
        connectionId: id,
        providerId: view.providerId,
        status: view.status,
        method: view.configuration.method,
      }
    : null;
}
export function bindNativeModelRuntime(activation: Activation): void {
  const captured = nativeProviderTransport();
  const fenced = (fence: HostedModelFence) => ({
    assertCurrent() {
      fence.signal.throwIfAborted();
      fence.assertCurrent();
      captured.assertCurrent();
    },
    fetch: (url: RequestInfo | URL, init?: RequestInit) => {
      fence.signal.throwIfAborted();
      fence.assertCurrent();
      const signal = init?.signal
        ? anySignal([fence.signal, init.signal])
        : fence.signal;
      return runUnlessAborted(signal, () =>
        captured.fetch(url, { ...init, signal }),
      );
    },
  });
  activation.onDispose(
    bindHostedModelAuthority({
      fetch: captured.fetch,
      assertCurrent: captured.assertCurrent,
      read: (id) => {
        captured.assertCurrent();
        return modelConnection(id);
      },
      connections: () => {
        captured.assertCurrent();
        return readDeviceRows().flatMap((row) => {
          const view = modelConnection(row.connectionId);
          return view ? [view] : [];
        });
      },
      execute: (id, definition, body, project, fence) =>
        executeNativeApiRequest(id, definition, body, project, fenced(fence)),
    }),
  );
}
