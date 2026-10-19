import { executeAiDelegatedRequest } from "@opensesame/app-core/lib/ai-connections/delegation.js";
import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
/** Only External connectors reads native authority and attaches model provider credentials. */
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  type HostedModelConnection,
  type HostedModelFence,
  bindHostedModelAuthority,
} from "@opensesame/app-core/lib/hosted-model-authority.js";
import { executeNativeApiRequest } from "@opensesame/app-core/lib/native-api-operations.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  type NativeProviderTransport,
  captureNativeProviderAuthority,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import type { Activation } from "../activation.js";
import { anySignal, runUnlessAborted } from "../signals.js";
function modelConnection(id: string): HostedModelConnection | null {
  const view = readNativeConnector(id);
  const ai = readAiConnection(id);
  if (!view) return null;
  const connection: HostedModelConnection = {
    connectionId: id,
    providerId: view.providerId,
    status: view.status,
    method: view.configuration.method,
  };
  if (ai) {
    connection.family = ai.family;
    connection.model = ai.model;
    connection.endpoint = ai.baseUrl;
    connection.name = ai.name;
  }
  return connection;
}
export function bindNativeModelRuntime(activation: Activation): void {
  const authority = captureNativeProviderAuthority();
  const fenced = (
    captured: NativeProviderTransport,
    fence: HostedModelFence,
  ) => ({
    signal: fence.signal,
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
      fetch: (url, init) => authority.capture().fetch(url, init),
      assertCurrent: authority.assertCurrent,
      read: (id) => {
        authority.assertCurrent();
        return modelConnection(id);
      },
      connections: () => {
        authority.assertCurrent();
        return readDeviceRows().flatMap((row) => {
          const view = modelConnection(row.connectionId);
          return view ? [view] : [];
        });
      },
      execute: (id, definition, body, project, fence) => {
        const captured = fenced(authority.capture(), fence);
        captured.assertCurrent();
        if (readAiConnection(id))
          return executeAiDelegatedRequest(
            id,
            definition,
            body,
            project,
            captured,
          );
        return executeNativeApiRequest(id, definition, body, project, captured);
      },
    }),
  );
}
