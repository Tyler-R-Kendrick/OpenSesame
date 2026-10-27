/** MCP takes one current route per user action and retains original cleanup ownership. */
import { bindNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-binding.js";
import { registerNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import type { NativeProviderCleanup } from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  type NativeProviderTransport,
  captureNativeProviderAuthority,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import {
  configuredMcpClassification,
  isConfiguredMcp,
  supportsConfiguredMcp,
} from "@opensesame/app-core/lib/native-mcp-configured-config.js";
import {
  createNativeMcpConnectorDriver,
  nativeMcpCleanup,
  supportsNativeMcpProvider,
} from "@opensesame/app-core/lib/native-mcp-connectors.js";
import type { Activation } from "../activation.js";
import { composeConfiguredMcpDriver } from "./native-mcp-configured-runtime.js";

function invocationTransport(
  transport: NativeProviderTransport,
  caller?: AbortSignal,
): NativeProviderTransport {
  if (!caller) return transport;
  const signal = AbortSignal.any([
    caller,
    ...(transport.signal ? [transport.signal] : []),
  ]);
  const assertCurrent = () => {
    transport.assertCurrent();
    signal.throwIfAborted();
  };
  return Object.freeze({
    ...transport,
    signal,
    assertCurrent,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      assertCurrent();
      return transport.fetch(input, {
        ...init,
        signal: AbortSignal.any([
          signal,
          ...(input instanceof Request ? [input.signal] : []),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
    },
  });
}

type McpCleanupRoute = (
  id: string,
  fingerprint: string,
  original?: NativeProviderTransport,
) => NativeProviderCleanup;
function mcpCleanupAdapter(
  authority: ReturnType<typeof captureNativeProviderAuthority>,
  cleanup: McpCleanupRoute,
): NativeProviderCleanup {
  return {
    capture: (id) => {
      const view = readNativeConnector(id);
      if (!view) throw new Error("Saved MCP connection not found");
      const adapter = cleanup(id, view.configuration.fingerprint);
      const transport = adapter.capture?.(id);
      if (!transport) throw new Error("Original MCP cleanup route unavailable");
      return transport;
    },
    classification: (configuration) =>
      isConfiguredMcp(configuration)
        ? configuredMcpClassification()
        : nativeMcpCleanup.classification(configuration),
    credentialSlots: (configuration, grant) => {
      if (isConfiguredMcp(configuration)) return [];
      const slots = nativeMcpCleanup.credentialSlots ?? [];
      return "call" in slots ? slots(configuration, grant) : slots;
    },
    prepare: (id, original) => {
      authority.assertCurrent();
      const view = readNativeConnector(id);
      if (!view || view.configuration.method !== "mcp")
        throw new Error("Saved MCP connection not found");
      return (
        cleanup(id, view.configuration.fingerprint, original).prepare?.(
          id,
          original,
        ) ?? Promise.resolve()
      );
    },
    finalize: (id, original) => {
      authority.assertCurrent();
      const view = readNativeConnector(id);
      if (!view || view.configuration.method !== "mcp")
        throw new Error("Saved MCP connection not found");
      return (
        cleanup(id, view.configuration.fingerprint, original).finalize?.(
          id,
          original,
        ) ?? Promise.resolve()
      );
    },
    cleanup: (obligation, context) =>
      cleanup(
        context.connectionId,
        context.configuration.fingerprint,
        context.transport,
      ).cleanup(obligation, context),
  };
}

export function bindNativeMcpRuntime(activation: Activation): void {
  const authority = captureNativeProviderAuthority();
  const cleanupRoutes = new Map<string, NativeProviderTransport>();
  activation.onDispose(() => cleanupRoutes.clear());
  const key = (id: string, fingerprint: string) =>
    JSON.stringify([id, fingerprint]);
  const driverFor = (transport: NativeProviderTransport) =>
    composeConfiguredMcpDriver(
      createNativeMcpConnectorDriver(transport),
      transport,
    );
  const operation = (id?: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const transport = authority.capture();
    if (id) {
      const view = readNativeConnector(id);
      if (!view || view.configuration.method !== "mcp")
        throw new Error("Saved MCP connection not found");
      const target = key(id, view.configuration.fingerprint);
      if (!cleanupRoutes.has(target)) cleanupRoutes.set(target, transport);
    }
    const captured = invocationTransport(transport, signal);
    return bindNativeConnectorDriver(driverFor(captured), captured);
  };
  const cleanup = (
    id: string,
    fingerprint: string,
    original?: NativeProviderTransport,
  ) => {
    authority.assertCurrent();
    const target = key(id, fingerprint);
    const transport =
      original ?? cleanupRoutes.get(target) ?? authority.capture();
    transport.assertCurrent();
    cleanupRoutes.set(target, transport);
    return bindNativeConnectorDriver(driverFor(transport), transport).cleanup;
  };
  activation.onDispose(
    registerNativeConnectorDriver(
      "mcp",
      bindNativeConnectorDriver(
        {
          supports: (id) =>
            supportsNativeMcpProvider(id) || supportsConfiguredMcp(id),
          configure: (input) => {
            const driver = operation();
            return driver.configure(input).then((view) => {
              const captured = driver.cleanup.capture?.(view.connectionId);
              if (captured)
                cleanupRoutes.set(
                  key(view.connectionId, view.configuration.fingerprint),
                  captured,
                );
              return view;
            });
          },
          verify: (id) => operation(id).verify(id),
          authorize: (id, actor) => {
            const authorize = operation(id).authorize;
            if (!authorize) throw new Error("MCP authorization is unavailable");
            return authorize(id, actor);
          },
          invoke: (id, method, input, signal?: AbortSignal) =>
            operation(id, signal).invoke(id, method, input),
          cleanup: mcpCleanupAdapter(authority, cleanup),
        },
        authority,
      ),
    ),
  );
}
