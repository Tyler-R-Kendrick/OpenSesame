/** MCP modes share the existing field/secret/scope controls and provider defaults. */
import type { McpInfo } from "@opensesame/app-core/lib/connect-plan.js";
import { nativeMcpMetadataUnavailableReason } from "@opensesame/app-core/lib/native-mcp-availability.js";
import { supportsNativeMcpProvider } from "@opensesame/app-core/lib/native-mcp-connectors.js";
import type {
  NativeField,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";
function authentication(publicAvailable: boolean): NativeField {
  return {
    id: "mcp_authentication",
    label: "MCP authentication",
    kind: "choice",
    secret: false,
    required: true,
    defaultValue: publicAvailable ? "oauth" : "",
    choices: [
      { id: "bearer", label: "Bring your own bearer token" },
      { id: "header", label: "Bring your own credential header" },
      { id: "anonymous", label: "No authentication (anonymous)" },
      ...(publicAvailable
        ? [{ id: "oauth", label: "Provider OAuth authorization" }]
        : []),
    ],
  };
}
export function configuredMcpDescriptor(
  id: string,
  metadata: McpInfo,
  publicMethod: NativeMethodDescriptor,
): NativeMethodDescriptor {
  if (metadata.status === "ok" && metadata.configurable === false)
    return publicMethod;
  const publicAvailable = supportsNativeMcpProvider(id);
  const required = (field: NativeField) =>
    ["bearer", "header", "anonymous"].map((value) => ({
      ...field,
      when: { fieldId: "mcp_authentication", value },
    }));
  const endpoint: NativeField = {
    id: "mcp_url",
    label: "MCP server endpoint",
    kind: "url",
    secret: false,
    required: true,
    defaultValue: metadata.url,
  };
  const resource: NativeField = {
    ...endpoint,
    id: "mcp_resource",
    label: "MCP resource audience",
    defaultValue:
      metadata.status === "ok"
        ? (metadata.resource ?? metadata.url)
        : metadata.url,
  };
  const transport: NativeField = {
    id: "mcp_transport",
    label: "MCP transport",
    kind: "choice",
    secret: false,
    required: true,
    defaultValue: new URL(metadata.url).pathname.endsWith("/sse")
      ? "sse"
      : "streamable-http",
    choices: [
      { id: "streamable-http", label: "Streamable HTTP" },
      { id: "sse", label: "Legacy SSE" },
    ],
  };
  return {
    ...publicMethod,
    label: "MCP",
    authorizeFirst: true,
    instructions:
      "Choose the MCP authentication contract documented by your server. Operator-supplied credentials are sealed as Token items in the open vault. Anonymous sends no credential. A connection is verified only after actual MCP initialization and tool discovery; this choice does not change the server's authentication requirements.",
    fields: [
      authentication(publicAvailable),
      ...publicMethod.fields.map((field) => ({
        ...field,
        when: { fieldId: "mcp_authentication", value: "oauth" },
      })),
      ...required(endpoint),
      ...required(resource),
      ...required(transport),
      {
        id: "mcp_post_endpoint",
        label: "MCP messages endpoint",
        kind: "url",
        secret: false,
        required: true,
        when: { fieldId: "mcp_transport", value: "sse" },
        help: "Pin the exact same-origin messages path for Legacy SSE. Server announcements cannot choose another destination.",
      },
      {
        id: "mcp_header",
        label: "MCP credential header",
        kind: "text",
        secret: false,
        required: true,
        defaultValue: "X-API-Key",
        when: { fieldId: "mcp_authentication", value: "header" },
        help: "Use the provider's documented credential header. Cookies, transport headers and MCP session headers are not allowed.",
      },
      ...["bearer", "header"].map((value) => ({
        id: "mcp_token",
        label: "MCP credential",
        kind: "text" as const,
        secret: true,
        required: true,
        when: { fieldId: "mcp_authentication", value },
        help: "Stored only in the original vault. Leave blank to retain the same saved destination and authentication binding.",
      })),
    ],
  };
}

export type NativeMcpAvailability = {
  available: boolean;
  reason?: string;
  inactiveReason?: string;
  actor: string;
  defaultScopes?: readonly string[];
};

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

export function nativeMcpDescriptor(
  providerId: string,
  info: McpInfo,
  availability: NativeMcpAvailability,
): NativeMethodDescriptor {
  const metadata = info.status === "ok" ? info : null;
  const defaults = availability.defaultScopes ?? metadata?.defaultScopes ?? [];
  return {
    id: "mcp",
    authorizeFirst: true,
    preferredRank:
      metadata?.status === "ok" && metadata.registration !== "manual" ? 10 : 40,
    label:
      metadata && metadata.registration !== "manual" ? "Managed MCP" : "MCP",
    available: availability.available,
    ...mcpUnavailableAdvice(providerId, info, availability),
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
              default: defaults.includes(scope),
            })),
          },
        ]
      : [],
  };
}
