/** Explicit MCP credentials compose with the existing public OAuth route per original action. */
import type { NativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import type { NativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { isConfiguredMcp } from "@opensesame/app-core/lib/native-mcp-configured-config.js";
import { createConfiguredMcpDriver } from "@opensesame/app-core/lib/native-mcp-configured-driver.js";
import { NativeMcpError } from "@opensesame/app-core/lib/native-mcp-target.js";
import { captureSecretBackendVault } from "@opensesame/app-core/lib/secret-backends/runtime-owners.js";
async function captureOwner(
  transport: NativeProviderTransport,
  caller?: AbortSignal,
) {
  transport.assertCurrent();
  caller?.throwIfAborted();
  if (!transport.signal) throw new NativeMcpError("disposed");
  const signal = AbortSignal.any([
    transport.signal,
    ...(caller ? [caller] : []),
  ]);
  const guard = await captureSecretBackendVault(signal);
  try {
    const combined = AbortSignal.any([signal, guard.signal]);
    const assertCurrent = () => {
      combined.throwIfAborted();
      transport.assertCurrent();
      if (guard.guest || !guard.current()) throw new NativeMcpError("disposed");
    };
    assertCurrent();
    return {
      tomb: guard.tomb,
      close: guard.close,
      transport: { ...transport, signal: combined, assertCurrent },
    };
  } catch (error) {
    guard.close();
    throw error;
  }
}
export function composeConfiguredMcpDriver(
  publicDriver: NativeConnectorDriver,
  transport: NativeProviderTransport,
): NativeConnectorDriver {
  const configured = createConfiguredMcpDriver({
    capture: (signal, original) => captureOwner(original ?? transport, signal),
  });
  const forConfiguration = (
    configuration: Parameters<typeof isConfiguredMcp>[0],
  ) => (isConfiguredMcp(configuration) ? configured : publicDriver);
  const forConnection = (id: string) => {
    const view = readNativeConnector(id);
    if (!view || view.configuration.method !== "mcp")
      throw new NativeMcpError("target");
    return forConfiguration(view.configuration);
  };
  return {
    supports: (id) => publicDriver.supports(id) || configured.supports(id),
    configure: (input) => {
      const mode = input.parameters.mcp_authentication;
      if (mode === undefined) return publicDriver.configure(input);
      if (mode === "oauth") {
        const { mcp_authentication, ...parameters } = input.parameters;
        return publicDriver.configure({ ...input, parameters });
      }
      return configured.configure(input);
    },
    verify: (id) => forConnection(id).verify(id),
    authorize: (id, actor) => {
      const driver = forConnection(id);
      if (driver !== publicDriver || !driver.authorize)
        throw new NativeMcpError("authorization");
      return driver.authorize(id, actor);
    },
    invoke: (id, operation, input, signal) =>
      forConnection(id).invoke(id, operation, input, signal),
    cleanup: {
      capture: () => {
        transport.assertCurrent();
        return transport;
      },
      classification: (configuration) =>
        forConfiguration(configuration).cleanup.classification(configuration),
      credentialSlots: (configuration, grant) => {
        const slots =
          forConfiguration(configuration).cleanup.credentialSlots ?? [];
        return "call" in slots ? slots(configuration, grant) : slots;
      },
      prepare: (id, original) =>
        forConnection(id).cleanup.prepare?.(id, original) ?? Promise.resolve(),
      finalize: (id, original) =>
        forConnection(id).cleanup.finalize?.(id, original) ?? Promise.resolve(),
      cleanup: (obligation, context) =>
        forConfiguration(context.configuration).cleanup.cleanup(
          obligation,
          context,
        ),
    },
  };
}
