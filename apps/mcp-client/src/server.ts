#!/usr/bin/env node
/**
 * Client MCP server — tools over a narrowly scoped Host agent capability.
 * Does not expose materialize / getSecret (ADR 0005 / 0017).
 * Host tools use a native-approved short-lived agent capability.
 */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { forAgent } from "@opensesame/observability";
import { isString } from "@opensesame/os-domain";
import { z } from "zod";
import {
  createApiClient,
  createAuthenticatedApiClient,
  normalizeHttpBaseUrl,
} from "./api-client.js";
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

export interface ClientServerOptions {
  hostUrl: string;
  /** Legacy configuration is ignored: human Identity sessions are not agent authority. */
  identityUrl?: string;
}

export function buildServer({ hostUrl }: ClientServerOptions): McpServer {
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

  server.tool("whoami", "Host API agent capability identity", {}, async () => {
    try {
      const client = await createAuthenticatedApiClient({
        baseUrl: hostUrl,
      });
      const data = await client.whoami();
      return { content: modelText(data) };
    } catch (e) {
      return modelError("whoami_failed", e instanceof Error ? e : String(e));
    }
  });

  server.tool(
    "host_discover",
    "Discover Host API protected-resource metadata (issuers, DPoP posture)",
    {},
    async () => {
      try {
        const client = await createAuthenticatedApiClient({
          baseUrl: hostUrl,
        });
        const data = await client.discover();
        return { content: modelText(data) };
      } catch (e) {
        return modelError(
          "host_discover_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "sync_push",
    "Push E2EE sync blobs (opaque ciphertext) to the Host API",
    {
      blobs: z
        .array(
          z.object({
            id: z.string().min(1).max(128),
            epoch: z.number().int().nonnegative(),
            ciphertextB64: z.string().min(1),
          }),
        )
        .min(1)
        .max(64),
    },
    async ({ blobs }) => {
      try {
        const client = await createAuthenticatedApiClient({
          baseUrl: hostUrl,
        });
        const data = await client.syncPush(blobs);
        return { content: modelText(data) };
      } catch (e) {
        return modelError(
          "sync_push_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "sync_pull",
    "Pull one bounded E2EE ciphertext page; continue with next_after while has_more is true",
    {
      since: z.number().int().nonnegative().optional(),
      after: z
        .object({
          epoch: z.number().int().nonnegative(),
          id: z.string().min(1).max(128),
        })
        .optional(),
      device: z.string().min(1).max(128).optional(),
    },
    async ({ since, after, device }) => {
      try {
        const client = await createAuthenticatedApiClient({
          baseUrl: hostUrl,
        });
        const data = await client.syncReadPage(
          after ?? { epoch: (since ?? 0) + 1, id: "" },
          device ?? "mcp-client",
        );
        return { content: modelText(data) };
      } catch (e) {
        return modelError(
          "sync_pull_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  return server;
}

/**
 * Response minimization (docs/security/audit-2026-08-22-mcp-response-minimization.md):
 * config metadata is re-projected through explicit allowlists so an upstream
 * that grows a field can never relay it — identifiers, versions and
 * timestamps only, never values and never free-form text.
 */
function secretConfigMetadata(view: {
  id: string;
  project_id: string;
  slug: string;
  environment: string;
  parent_config_id?: string | null | undefined;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: view.id,
    project_id: view.project_id,
    slug: view.slug,
    environment: view.environment,
    parent_config_id: view.parent_config_id ?? null,
    created_at: view.created_at,
    updated_at: view.updated_at,
  };
}

function configKeyMetadata(key: {
  key_name: string;
  version: number;
  updated_at: string;
}) {
  return {
    key_name: key.key_name,
    version: key.version,
    updated_at: key.updated_at,
  };
}

export async function main(): Promise<void> {
  const hostUrl = requireBase(
    process.env.OPENSESAME_HOST_API ?? "http://127.0.0.1:8787",
    "OPENSESAME_HOST_API",
  );
  const server = buildServer({ hostUrl });
  const transport = new stdioTransportSeams.StdioServerTransport();
  await server.connect(transport);
}

const isMain =
  isString(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  await main();
}
