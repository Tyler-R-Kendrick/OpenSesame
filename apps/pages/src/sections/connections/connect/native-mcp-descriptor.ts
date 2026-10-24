/** A provider's published MCP road, read from its plan (ADR 0139). */
import type {
  ConnectMethod,
  ConnectPlan,
  McpInfo,
} from "@opensesame/app-core/lib/connect-plan.js";
import { nativeMcpMetadataUnavailableReason } from "@opensesame/app-core/lib/native-mcp-availability.js";
import type {
  NativeConnectorDescriptor,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";
import { configuredMcpDescriptor } from "./native-mcp-configured-descriptor.js";

export type NativeMcpAvailability = {
  available: boolean;
  reason?: string;
  inactiveReason?: string;
  actor: string;
  defaultScopes?: readonly string[];
};

type McpMethod = Extract<ConnectMethod, { kind: "mcp" }>;

function mcpUnavailableAdvice(
  providerId: string,
  metadata: McpInfo,
  availability: NativeMcpAvailability,
): Pick<NativeMethodDescriptor, "unavailableReason" | "unavailableKind"> {
  const reason =
    availability.reason ??
    nativeMcpMetadataUnavailableReason(providerId, metadata) ??
    undefined;
  if (!availability.available && reason === undefined)
    return {
      unavailableKind: "runtime-inactive",
      unavailableReason:
        availability.inactiveReason ??
        "Enable External connectors in Settings › Features to activate this connection on this device.",
    };
  return {
    unavailableKind: "no-public-contract",
    unavailableReason:
      reason ??
      "The provider has not advertised a public browser authorization contract for its MCP server.",
  };
}

function mcpDescriptor(
  providerId: string,
  method: McpMethod,
  availability: NativeMcpAvailability,
): NativeMethodDescriptor {
  const metadata = method.mcp.status === "ok" ? method.mcp : null;
  return {
    id: "mcp",
    authorizeFirst: true,
    preferredRank:
      metadata?.status === "ok" && metadata.registration !== "manual" ? 10 : 40,
    label:
      metadata && metadata.registration !== "manual" ? "Managed MCP" : "MCP",
    available: availability.available,
    ...mcpUnavailableAdvice(providerId, method.mcp, availability),
    instructions:
      "Connect to this provider's published MCP server. OpenSesame verifies its advertised tools before reporting a connection.",
    fields:
      metadata?.registration === "manual"
        ? [
            {
              id: "client_id",
              label: "Public MCP client ID",
              kind: "text",
              secret: false,
              required: true,
            },
          ]
        : [],
    scopeGroups: metadata
      ? [
          {
            actor: availability.actor,
            label: "MCP permissions",
            choices: metadata.scopes.map((scope) => ({
              name: scope,
              description:
                "Permission advertised by the provider's MCP authorization server.",
              default: availability.defaultScopes?.includes(scope) ?? false,
            })),
          },
        ]
      : [],
  };
}

/** The published MCP road, and its configurable modes unless the plan withholds them. */
export function publishedMcpDescriptor(
  providerId: string,
  method: McpMethod,
  availability: NativeMcpAvailability,
): NativeMethodDescriptor {
  const published = mcpDescriptor(providerId, method, availability);
  return method.mcp.status === "ok" && method.mcp.configurable === false
    ? published
    : configuredMcpDescriptor(providerId, method.mcp, published);
}

/** The MCP permissions a plan selects by default (spec/connectors/connect-presets.json). */
export function planDefaultMcpScopes(
  plan: ConnectPlan,
): readonly string[] | undefined {
  for (const method of plan.methods)
    if (method.kind === "mcp" && method.mcp.status === "ok")
      return method.mcp.defaultScopes;
  return undefined;
}

/**
 * A plan with a primary method offers only that road on its own page; its
 * other methods are an explicit fallback that page draws. A saved record
 * keeps the method it was made with.
 */
export function planPageMethods(
  descriptor: NativeConnectorDescriptor,
  plan: ConnectPlan,
  savedMethod?: string,
): NativeConnectorDescriptor {
  if (plan.primaryMethod === undefined) return descriptor;
  const road = savedMethod ?? plan.primaryMethod;
  return {
    ...descriptor,
    methods: descriptor.methods.filter((method) => method.id === road),
  };
}
