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
      return modelError("whoami_failed", e instanceof Error ? e : String(e));
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
        return modelError(
          "list_connections_failed",
          e instanceof Error ? e : String(e),
        );
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
        return modelError("invoke_failed", e instanceof Error ? e : String(e));
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
      try {
        const headers = {
          accept: "application/json",
          "x-claim-token": claimToken,
          authorization: `Bearer ${requireIdentityToken()}`,
        };
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
        return modelError(
          "present_claim_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "host_discover",
    "Discover Host API protected-resource metadata (issuers, DPoP posture)",
    {},
    async () => {
      try {
        const client = createApiClient({
          baseUrl: hostUrl,
          accessToken: requireAccessToken(),
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
    "integration_read",
    "Read configured integrations (all, or one by id)",
    { id: z.string().optional() },
    async ({ id }) => {
      try {
        const client = createApiClient({
          baseUrl: hostUrl,
          accessToken: requireAccessToken(),
        });
        const data = id
          ? await client.getIntegration(id)
          : await client.listIntegrations();
        return { content: modelText(data) };
      } catch (e) {
        return modelError(
          "integration_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "sync_target_read",
    "Read replication sync targets (all, or one by id); never returns secrets",
    { id: z.string().optional() },
    async ({ id }) => {
      try {
        const client = createApiClient({
          baseUrl: hostUrl,
          accessToken: requireAccessToken(),
        });
        const data = id
          ? await client.getSyncTarget(id)
          : await client.listSyncTargets();
        return { content: modelText(data) };
      } catch (e) {
        return modelError(
          "sync_target_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "config_metadata_read",
    "Browse secret-config metadata — ids, key names, versions, timestamps; never values",
    {
      projectId: z.string().optional(),
      configId: z.string().optional(),
    },
    async ({ projectId, configId }) => {
      try {
        const client = createApiClient({
          baseUrl: hostUrl,
          accessToken: requireAccessToken(),
        });
        if (configId) {
          const data = await client.listConfigKeys(configId);
          return {
            content: modelText({ keys: data.keys.map(configKeyMetadata) }),
          };
        }
        if (projectId) {
          const data = await client.listSecretConfigs(projectId);
          return {
            content: modelText({
              configs: data.configs.map(secretConfigMetadata),
            }),
          };
        }
        throw new Error("projectId or configId is required");
      } catch (e) {
        return modelError(
          "config_metadata_read_failed",
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
        const client = createApiClient({
          baseUrl: hostUrl,
          accessToken: requireAccessToken(),
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
    "Pull E2EE sync blobs (opaque ciphertext) from the Host API",
    {
      since: z.number().int().nonnegative().optional(),
      device: z.string().min(1).max(128).optional(),
    },
    async ({ since, device }) => {
      try {
        const client = createApiClient({
          baseUrl: hostUrl,
          accessToken: requireAccessToken(),
        });
        const data = await client.syncPull({
          epoch: since ?? 0,
          deviceId: device ?? "mcp-client",
        });
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
