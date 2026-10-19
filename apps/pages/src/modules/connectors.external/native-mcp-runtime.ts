/** MCP takes one current route per user action and retains original cleanup ownership. */
import { bindNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-binding.js";
import { registerNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  type NativeProviderTransport,
  captureNativeProviderAuthority,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import {
  createNativeMcpConnectorDriver,
  nativeMcpCleanup,
  supportsNativeMcpProvider,
} from "@opensesame/app-core/lib/native-mcp-connectors.js";
import type { Activation } from "../activation.js";

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

export function bindNativeMcpRuntime(activation: Activation): void {
  const authority = captureNativeProviderAuthority();
  const cleanupRoutes = new Map<string, NativeProviderTransport>();
  activation.onDispose(() => cleanupRoutes.clear());
  const key = (id: string, fingerprint: string) =>
    JSON.stringify([id, fingerprint]);
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
    return bindNativeConnectorDriver(
      createNativeMcpConnectorDriver(captured),
      captured,
    );
  };
  const cleanup = (id: string, fingerprint: string) => {
    authority.assertCurrent();
    const target = key(id, fingerprint);
    const transport = cleanupRoutes.get(target) ?? authority.capture();
    transport.assertCurrent();
    cleanupRoutes.set(target, transport);
    return bindNativeConnectorDriver(
      createNativeMcpConnectorDriver(transport),
      transport,
    ).cleanup;
  };
  activation.onDispose(
    registerNativeConnectorDriver(
      "mcp",
      bindNativeConnectorDriver(
        {
          supports: supportsNativeMcpProvider,
          configure: (input) => operation().configure(input),
          verify: (id) => operation(id).verify(id),
          authorize: (id, actor) => {
            const authorize = operation(id).authorize;
            if (!authorize) throw new Error("MCP authorization is unavailable");
            return authorize(id, actor);
          },
          invoke: (id, method, input, signal?: AbortSignal) =>
            operation(id, signal).invoke(id, method, input),
          cleanup: {
            classification: nativeMcpCleanup.classification,
            credentialSlots: nativeMcpCleanup.credentialSlots,
            prepare: (id) => {
              authority.assertCurrent();
              const view = readNativeConnector(id);
              if (!view || view.configuration.method !== "mcp")
                throw new Error("Saved MCP connection not found");
              return (
                cleanup(id, view.configuration.fingerprint).prepare?.(id) ??
                Promise.resolve()
              );
            },
            cleanup: (obligation, context) =>
              cleanup(
                context.connectionId,
                context.configuration.fingerprint,
              ).cleanup(obligation, context),
          },
        },
        authority,
      ),
    ),
  );
}
