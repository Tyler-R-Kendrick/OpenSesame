#!/usr/bin/env node
/**
 * Client MCP server — password workflow guidance only (Host API tools removed).
 */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { forAgent } from "@opensesame/observability";
import { isString } from "@opensesame/os-domain";
import {
  PASSWORD_WORKFLOW_RESOURCE,
  passwordWorkflowGuide,
} from "./password-workflow-resource.js";
import { stdioTransportSeams } from "./stdio-transport.js";
import { assertsNoMaterializeTool, toolsManifest } from "./tools.js";

export function modelText<Value>(value: Value) {
  const serialized = JSON.stringify(value);
  if (!isString(serialized)) throw new Error("model payload is not JSON");
  return [{ type: "text" as const, text: forAgent(serialized) }];
}

export function modelError(label: string, error: Error | string) {
  try {
    const message = error instanceof Error ? error.message : error;
    return { content: modelText({ error: label, message }), isError: true };
  } catch {
    return { content: modelText({ error: label }), isError: true };
  }
}

export function buildServer(): McpServer {
  assertsNoMaterializeTool(toolsManifest);
  const server = new McpServer({
    name: "opensesame-mcp-client",
    version: "0.1.0",
  });

  server.registerResource(
    "password-workflows",
    PASSWORD_WORKFLOW_RESOURCE,
    {
      title: "Password workflows and human approval",
      mimeType: "application/json",
      description:
        "Human vault handoffs and custody boundaries; no vault values or request authority",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(passwordWorkflowGuide),
        },
      ],
    }),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = buildServer();
  const transport = new stdioTransportSeams.StdioServerTransport();
  await server.connect(transport);
}

const isMain =
  isString(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  await main();
}
