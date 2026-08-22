#!/usr/bin/env node
/**
 * Client MCP server — tools over Host api-client + Identity claim present.
 * Does not expose materialize / getSecret (ADR 0005 / 0017).
 * Host mutating/session tools require OPENSESAME_ACCESS_TOKEN (opaque-session).
 */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { forAgent } from "@opensesame/observability";
import { isString } from "@opensesame/os-domain";
import { z } from "zod";
import { createApiClient, normalizeHttpBaseUrl } from "./api-client.js";
import { stdioTransportSeams } from "./stdio-transport.js";
import { toolsManifest } from "./tools.js";

/**
 * Both endpoints come from the environment, and every call to them carries the
 * session bearer — so a base URL that is not https off loopback would hand that
 * bearer to the network. Refuse at startup rather than leak on first use.
 */
export function requireBase(raw: string, envName: string): string {
  const normalized = normalizeHttpBaseUrl(raw);
  if (!normalized) {
    throw new Error(`${envName} must be an https URL, or http on loopback`);
  }
  return normalized;
}

export function requireAccessToken(): string {
  const tok = process.env.OPENSESAME_ACCESS_TOKEN?.trim();
  if (!tok) {
    throw new Error(
      "OPENSESAME_ACCESS_TOKEN required (opaque-session from `opensesame login`)",
    );
  }
  return tok;
}

export function requireIdentityToken(): string {
  const tok = process.env.OPENSESAME_IDENTITY_TOKEN?.trim();
  if (!tok) {
    throw new Error("OPENSESAME_IDENTITY_TOKEN required for Identity claims");
  }
  return tok;
}

export function modelText(value: unknown) {
  const serialized = JSON.stringify(value);
  if (!isString(serialized)) throw new Error("model payload is not JSON");
  return [{ type: "text" as const, text: forAgent(serialized) }];
}

export function modelError(label: string, error: unknown) {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return { content: modelText({ error: label, message }), isError: true };
  } catch {
    return { content: modelText({ error: label }), isError: true };
  }
}

export interface ClientServerOptions {
  hostUrl: string;
  identityUrl: string;
}

export function buildServer({
  hostUrl,
  identityUrl,
}: ClientServerOptions): McpServer {
  const server = new McpServer({
    name: "opensesame-mcp-client",
    version: "0.1.0",
  });

  server.tool("host_health", "Check Host API liveness", {}, async () => {
    const client = createApiClient({ baseUrl: hostUrl });
    const health = await client.health();
    const daemon = await client.probeDaemon();
    return {
      content: modelText({ health, daemon, tools: toolsManifest }),
    };
  });

  server.tool("whoami", "Host API whoami (opaque session)", {}, async () => {
    try {
      const client = createApiClient({
        baseUrl: hostUrl,
        accessToken: requireAccessToken(),
      });
      const data = await client.whoami();
      return { content: modelText(data) };
    } catch (e) {
      return modelError("whoami_failed", e);
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
        return { content: modelText(data) };
      } catch (e) {
        return modelError("list_connections_failed", e);
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
        return { content: modelText(data) };
      } catch (e) {
        return modelError("invoke_failed", e);
      }
    },
  );

  server.tool(
    "present_claim",
    "Present / poll an Identity API claim (step-up); never returns secrets",
    {
      claimId: z.string(),
      claimToken: z.string().describe("osc_clm_… claim bearer (required)"),
    },
    async ({ claimId, claimToken }) => {
      const base = identityUrl.replace(/\/$/, "");
      const headers: Record<string, string> = {
        accept: "application/json",
        "x-claim-token": claimToken,
      };
      try {
        headers.authorization = `Bearer ${requireIdentityToken()}`;
        const res = await fetch(
          `${base}/v1/claims/${encodeURIComponent(claimId)}`,
          {
            headers,
          },
        );
        const text = await res.text();
        return {
          content: modelText({ status: res.status, body: text }),
          isError: !res.ok,
        };
      } catch (e) {
        return modelError("present_claim_failed", e);
      }
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const hostUrl = requireBase(
    process.env.OPENSESAME_HOST_API ?? "http://127.0.0.1:8787",
    "OPENSESAME_HOST_API",
  );
  const identityUrl = requireBase(
    process.env.OPENSESAME_ISSUER ?? "http://127.0.0.1:8788",
    "OPENSESAME_ISSUER",
  );
  const server = buildServer({ hostUrl, identityUrl });
  const transport = new stdioTransportSeams.StdioServerTransport();
  await server.connect(transport);
}

const isMain =
  isString(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  await main();
}
