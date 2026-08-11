#!/usr/bin/env node
/**
 * Client MCP server — tools over Host api-client + Identity claim present.
 * Does not expose materialize / getSecret (ADR 0005 / 0017).
 * Host mutating/session tools require OPENSESAME_ACCESS_TOKEN (opaque-session).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createApiClient, normalizeHttpBaseUrl } from "@opensesame/api-client";
import { toolsManifest } from "./tools.js";

/**
 * Both endpoints come from the environment, and every call to them carries the
 * session bearer — so a base URL that is not https off loopback would hand that
 * bearer to the network. Refuse at startup rather than leak on first use.
 */
function requireBase(raw: string, envName: string): string {
  const normalized = normalizeHttpBaseUrl(raw);
  if (!normalized) {
    throw new Error(`${envName} must be an https URL, or http on loopback`);
  }
  return normalized;
}

const hostUrl = requireBase(
  process.env.OPENSESAME_HOST_API ?? "http://127.0.0.1:8787",
  "OPENSESAME_HOST_API",
);
const identityUrl = requireBase(
  process.env.OPENSESAME_ISSUER ?? "http://127.0.0.1:8788",
  "OPENSESAME_ISSUER",
);

function requireAccessToken(): string {
  const tok = process.env.OPENSESAME_ACCESS_TOKEN?.trim();
  if (!tok) {
    throw new Error(
      "OPENSESAME_ACCESS_TOKEN required (opaque-session from `opensesame login`)",
    );
  }
  return tok;
}

const server = new McpServer({
  name: "opensesame-mcp-client",
  version: "0.1.0",
});

server.tool("host_health", "Check Host API liveness", {}, async () => {
  const client = createApiClient({ baseUrl: hostUrl });
  const health = await client.health();
  const daemon = await client.probeDaemon();
  return {
    content: [{ type: "text", text: JSON.stringify({ health, daemon, tools: toolsManifest }) }],
  };
});

server.tool("whoami", "Host API whoami (opaque session)", {}, async () => {
  try {
    const client = createApiClient({
      baseUrl: hostUrl,
      accessToken: requireAccessToken(),
    });
    const data = await client.whoami();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (e) {
    return {
      content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }
});

server.tool(
  "list_connections",
  "List ConnectionRefs from Host API",
  {},
  async () => {
    try {
      const client = createApiClient({
        baseUrl: hostUrl,
        accessToken: requireAccessToken(),
      });
      const data = await client.listConnections();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "invoke_l1",
  "Authorize and invoke L1 typed operation (never materialize)",
  {
    connectionRef: z.string(),
    operation: z.string(),
    resource: z.string(),
  },
  async ({ connectionRef, operation, resource }) => {
    try {
      const client = createApiClient({
        baseUrl: hostUrl,
        accessToken: requireAccessToken(),
      });
      const data = await client.invoke({
        connectionRef,
        operation,
        resource,
        invokeLevel: 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "present_claim",
  "Present / poll an Identity API claim (step-up); never returns secrets",
  {
    claimId: z.string(),
    claimToken: z.string().describe("osc_clm_… claim bearer (required)"),
    accessToken: z.string().optional(),
  },
  async ({ claimId, claimToken, accessToken }) => {
    const base = identityUrl.replace(/\/$/, "");
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-claim-token": claimToken,
    };
    const tok = accessToken ?? process.env.OPENSESAME_ACCESS_TOKEN;
    if (tok) headers.authorization = `Bearer ${tok}`;
    try {
      const res = await fetch(`${base}/v1/claims/${encodeURIComponent(claimId)}`, {
        headers,
      });
      const text = await res.text();
      return {
        content: [{ type: "text", text: JSON.stringify({ status: res.status, body: text }) }],
        isError: !res.ok,
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
