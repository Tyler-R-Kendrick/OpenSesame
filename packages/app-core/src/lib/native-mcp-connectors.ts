import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
/** Native provider dispatcher; MCP tools remain exactly what its resource advertises. */
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
} from "@opensesame/os-domain";
import type { NativeConnectorDriver } from "./native-connector-drivers.js";
import { beginNativeMcpAuthorization } from "./native-mcp-authorization.js";
import { supportsCompiledNativeMcpProvider } from "./native-mcp-availability.js";
import {
  createNativeMcpCleanup,
  nativeMcpCleanup,
} from "./native-mcp-cleanup.js";
import { configureNativeMcpConnector } from "./native-mcp-config.js";
import { nativeMcpInputGuide } from "./native-mcp-guide.js";
import {
  invokeNativeMcpTool,
  listNativeMcpTools,
} from "./native-mcp-operations.js";
export { nativeMcpUnavailableReason } from "./native-mcp-availability.js";
import { NativeMcpError } from "./native-mcp-target.js";
import { verifyNativeMcpConnector } from "./native-mcp-verification.js";

import type { NativeProviderTransport } from "./native-connector-transport.js";
export { configureNativeMcpConnector } from "./native-mcp-config.js";
export {
  beginNativeMcpAuthorization,
  finishNativeMcpAuthorization,
} from "./native-mcp-authorization.js";
export { verifyNativeMcpConnector } from "./native-mcp-verification.js";
export {
  listNativeMcpTools,
  invokeNativeMcpTool,
} from "./native-mcp-operations.js";
export { nativeMcpCleanup } from "./native-mcp-cleanup.js";

export function supportsNativeMcpProvider(providerId: string): boolean {
  return supportsCompiledNativeMcpProvider(providerId);
}

export type NativeMcpActionPort = {
  list: () => ReturnType<typeof listNativeMcpTools>;
  call: (
    name: string,
    args: JsonObject,
  ) => ReturnType<typeof invokeNativeMcpTool>;
};

export async function invokeNativeMcpAction(
  operationId: string,
  input: Record<string, string>,
  port: NativeMcpActionPort,
) {
  if (operationId === "mcp.tools.list" && Object.keys(input).length === 0) {
    const discovery = await port.list();
    return {
      label: discovery.server.name,
      items: discovery.tools.map((tool) => ({
        id: tool.name,
        label: tool.description ?? tool.name,
        inputSchema: nativeMcpInputGuide(tool.inputSchema),
      })),
    };
  }
  if (
    !operationId.startsWith("mcp.tool:") ||
    Object.keys(input).some((key) => key !== "arguments") ||
    (input.arguments?.length ?? 0) > 32768
  )
    throw new NativeMcpError("tool");
  let args: BoundaryValue;
  try {
    args = JSON.parse(input.arguments ?? "{}");
  } catch {
    throw new NativeMcpError("arguments", 0, "json-object");
  }
  if (!isJsonObject(args))
    throw new NativeMcpError("arguments", 0, "json-object");
  const result = await port.call(operationId.slice("mcp.tool:".length), args);
  const parsed = CallToolResultSchema.parse(result);
  const text = parsed.content.filter((content) => content.type === "text");
  return {
    label: parsed.isError ? "MCP tool returned an error" : "MCP tool result",
    items: text.map((content, index) => ({
      id: String(index),
      label: content.text,
    })),
  };
}
async function invoke(
  id: string,
  operationId: string,
  input: Record<string, string>,
  transport?: NativeProviderTransport,
) {
  return invokeNativeMcpAction(operationId, input, {
    list: () => listNativeMcpTools(id, transport),
    call: (name, args) => invokeNativeMcpTool(id, name, args, transport),
  });
}
export const nativeMcpConnectorDriver: NativeConnectorDriver = {
  cleanup: nativeMcpCleanup,
  supports: supportsNativeMcpProvider,
  configure: configureNativeMcpConnector,
  verify: verifyNativeMcpConnector,
  authorize: beginNativeMcpAuthorization,
  invoke: (id, operationId, input) => invoke(id, operationId, input),
};

export {
  nativeMcpRevocationInstructions,
  attestNativeMcpRevocation,
} from "./native-mcp-attestation.js";

export function createNativeMcpConnectorDriver(
  transport: NativeProviderTransport,
): NativeConnectorDriver {
  return {
    cleanup: createNativeMcpCleanup(transport),
    supports: supportsNativeMcpProvider,
    configure: (input) => configureNativeMcpConnector(input, transport),
    verify: (id) => verifyNativeMcpConnector(id, transport),
    authorize: (id, actor) => beginNativeMcpAuthorization(id, actor, transport),
    invoke: (id, operationId, input) =>
      invoke(id, operationId, input, transport),
  };
}
