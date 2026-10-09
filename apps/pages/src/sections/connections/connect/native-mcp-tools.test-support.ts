/** Real OAuth, sealed KV and MCP SDK requests against typed provider fixtures. */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import {
  beginNativeMcpAuthorization,
  configureNativeMcpConnector,
  finishNativeMcpAuthorization,
} from "@opensesame/app-core/lib/native-mcp-connectors.js";
import { fixture as oauthResponse } from "@opensesame/app-core/lib/native-mcp-oauth-fixtures.test-helper.js";
import { nativeMcpRecordOAuthTarget } from "@opensesame/app-core/lib/native-mcp-profile.js";
import { requireNativeMcpRecord } from "@opensesame/app-core/lib/native-mcp-records.js";
import type { JsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import { nativeConnectorController } from "./native-connector-controller.js";
import { connectorIntegration } from "./native-connector-integration.test-support.js";

export const advertisedArguments = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    filter: {
      type: "object",
      properties: { published: { type: "boolean" } },
      required: ["published"],
      additionalProperties: false,
    },
  },
  required: ["query", "filter"],
  additionalProperties: false,
};

const Rpc = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
});

export async function nativeMcpToolsFixture() {
  const fixture = connectorIntegration();
  const saved = await configureNativeMcpConnector({
    providerId: "adobe",
    method: "mcp",
    displayName: "Adobe provider tools",
    parameters: {},
    credentials: {},
    requestedScopes: { user: [] },
    targetIds: {},
  });
  const methods: string[] = [];
  fixture.route.respond = async (request) => {
    const target = nativeMcpRecordOAuthTarget(
      requireNativeMcpRecord(saved.connectionId).configuration,
    );
    if (request.url !== target.binding.endpoint)
      return oauthResponse(target).ports.fetch(request);
    if (request.method === "GET") return new Response(null, { status: 405 });
    const rpc = Rpc.parse(JSON.parse(await request.text()));
    methods.push(rpc.method);
    if (rpc.method.startsWith("notifications/"))
      return new Response(null, { status: 202 });
    let result: JsonObject;
    if (rpc.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "Adobe advertised tools", version: "1.0" },
      };
    else if (rpc.method === "tools/list")
      result = {
        tools: [
          {
            name: "provider.search",
            description: "Search published provider records",
            inputSchema: advertisedArguments,
          },
        ],
      };
    else if (rpc.method === "tools/call")
      result = {
        content: [{ type: "text", text: "Actual provider tool result" }],
      };
    else throw new Error("Unexpected provider MCP method");
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  };
  await beginNativeMcpAuthorization(saved.connectionId);
  const pending = requireNativeMcpRecord(saved.connectionId).privateState
    .pending.user;
  if (!pending) throw new Error("Missing actual MCP authorization");
  await finishNativeMcpAuthorization(
    `?${new URLSearchParams({ native_state: pending.state, native_code: "issued-code" })}`,
  );
  const plan = connectPlan("adobe");
  if (!plan) throw new Error("Missing compiled Adobe provider");
  const controller = nativeConnectorController(plan, saved.connectionId);
  const view = controller.load();
  if (!view) throw new Error("Missing saved provider view");
  return { fixture, methods, controller, view };
}
