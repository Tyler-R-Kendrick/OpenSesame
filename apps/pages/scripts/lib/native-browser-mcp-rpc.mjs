/** Actual JSON-RPC responses for the disclosed MCP HTTP authority. */
import { isString } from "../../../../scripts/lib/json-boundary.mjs";
import { publicAuthorityReply } from "./native-public-consent-authority.mjs";

export const NATIVE_BROWSER_MCP_INPUT_SCHEMA = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
};

export function answerMcpProtocol(
  route,
  { request, method, headers, state, access, harness },
) {
  if (method === "GET") {
    state.expectedResponses.set(request, 405);
    return publicAuthorityReply(route, null, 405);
  }
  harness.check(
    headers.authorization === `Bearer ${access}`,
    "MCP protocol uses the sealed bound access token",
  );
  const rpc = request.postDataJSON();
  state.calls.at(-1).rpc = rpc.method;
  if (rpc.method === "notifications/initialized")
    return publicAuthorityReply(route, null, 202);
  if (rpc.method === "tools/call" && state.rejectTools) {
    state.expectedResponses.set(request, 401);
    return publicAuthorityReply(route, { error: "invalid_token" }, 401);
  }
  let result;
  if (rpc.method === "initialize")
    result = {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: {
        name: "Disclosed Adobe protocol authority",
        version: "1.0",
      },
    };
  else if (rpc.method === "tools/list")
    result = {
      tools: [
        {
          name: "provider.search",
          description: "Search the disclosed protocol authority",
          inputSchema:
            state.unsafeSchema === "input"
              ? unsafeSchema()
              : NATIVE_BROWSER_MCP_INPUT_SCHEMA,
          outputSchema:
            state.unsafeSchema === "output"
              ? unsafeSchema()
              : {
                  type: "object",
                  properties: { matches: { type: "integer" } },
                  required: ["matches"],
                  additionalProperties: false,
                },
        },
      ],
    };
  else if (rpc.method === "tools/call") {
    harness.check(
      rpc.params.name === "provider.search" &&
        isString(rpc.params.arguments.query),
      "tool call uses the actual advertised name and validated arguments",
    );
    result = {
      structuredContent: { matches: 1 },
      content: [
        {
          type: "text",
          text: `Protocol authority returned: ${rpc.params.arguments.query}`,
        },
      ],
    };
  } else throw new Error(`Unexpected MCP RPC ${rpc.method}`);
  return publicAuthorityReply(route, { jsonrpc: "2.0", id: rpc.id, result });
}

function unsafeSchema() {
  return {
    type: "object",
    properties: { query: { type: "string", pattern: "^(a+)+$" } },
  };
}
