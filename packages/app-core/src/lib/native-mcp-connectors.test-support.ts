import type { JsonObject } from "@opensesame/os-domain";
import { afterEach, expect, vi } from "vitest";
import { z } from "zod";
import { installNativeApiTests } from "./native-api.test-support.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import { registerNativeProviderCleanup } from "./native-connector-lifecycle.js";
import { bindNativeProviderTransport } from "./native-connector-transport.js";
import { nativeMcpCleanup } from "./native-mcp-cleanup.js";
import { configureNativeMcpConnector } from "./native-mcp-config.js";
import { fixture } from "./native-mcp-oauth-fixtures.test-helper.js";
import {
  nativeMcpProviderMetadata,
  nativeMcpRecordOAuthTarget,
} from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";

const RpcSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
});
export const advertisedTool = {
  name: "provider.search",
  description: "Search records from this MCP resource",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};
const releases: (() => void)[] = [];
export function installNativeMcpConnectorTests(): void {
  installNativeApiTests();
  afterEach(() => {
    for (const release of releases.splice(0)) release();
  });
}
export type ConnectorFixtureOptions = {
  providerId?: string;
  unauthorized?: boolean;
  noTools?: boolean;
  onToken?: () => void;
  tokenFailure?: boolean;
  echoToken?: boolean;
  inputSchema?: JsonObject;
  metadataFailure?: boolean;
  onList?: () => Promise<void>;
  management?: boolean;
  deleteFailure?: boolean;
  onRegistration?: () => void;
};
async function oauthFixtureFetch(
  request: Request,
  id: string,
  options: ConnectorFixtureOptions,
): Promise<Response> {
  const target = nativeMcpRecordOAuthTarget(
    requireNativeMcpRecord(id).configuration,
  );
  if (options.metadataFailure && request.method === "GET")
    return new Response(null, { status: 503 });
  if (request.method === "DELETE")
    return new Response(null, {
      status: options.deleteFailure ? 503 : 204,
    });
  if (request.url === target.metadata.registrationEndpoint)
    options.onRegistration?.();
  const registered: JsonObject = {
    client_id: "actual-public-client",
    redirect_uris: [target.redirectUri],
    token_endpoint_auth_method: "none",
  };
  if (options.management) {
    registered.registration_client_uri = `${target.metadata.registrationEndpoint}/actual-public-client`;
    registered.registration_access_token = "private-management-token";
  }
  return fixture(target, {
    registered,
    tokenFailure: options.tokenFailure,
    onToken: options.onToken,
  }).ports.fetch(request);
}

function mcpFixtureFetch(
  endpoint: string,
  getId: () => string,
  options: ConnectorFixtureOptions,
  methods: string[],
  requests: Request[],
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    if (request.url !== endpoint) {
      return oauthFixtureFetch(request, getId(), options);
    }
    if (request.method === "GET") return new Response(null, { status: 405 });
    const rpc = RpcSchema.parse(JSON.parse(await request.text()));
    methods.push(rpc.method);
    if (rpc.method.startsWith("notifications/"))
      return new Response(null, { status: 202 });
    if (options.unauthorized && rpc.method === "tools/call")
      return new Response("Refused", { status: 401 });
    let result: JsonObject;
    if (rpc.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: options.noTools ? {} : { tools: {} },
        serverInfo: { name: "Actual advertised server", version: "1.0" },
      };
    else if (rpc.method === "tools/list") {
      await options.onList?.();
      result = {
        tools: [
          {
            ...advertisedTool,
            inputSchema: options.inputSchema ?? advertisedTool.inputSchema,
          },
        ],
      };
    } else {
      expect(rpc.method).toBe("tools/call");
      result = {
        content: [
          {
            type: "text",
            text: options.echoToken
              ? "reflected issued-access"
              : "Actual provider tool result",
          },
        ],
      };
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
      { headers: { "content-type": "application/json" } },
    );
  };
}

export async function mcpConnectorFixture(
  options: ConnectorFixtureOptions = {},
) {
  const providerId = options.providerId ?? "adobe";
  const metadata = nativeMcpProviderMetadata(providerId);
  const methods: string[] = [];
  const requests: Request[] = [];
  let id = "";
  let active = true;
  const navigate = vi.fn();
  releases.push(
    bindNativeOAuthBrowserPort({
      redirectUri: "https://self-host.example.org/auth/native-connector.html",
      navigate,
      scrubCallback: vi.fn(),
    }),
  );
  const fetcher = mcpFixtureFetch(
    metadata.url,
    () => id,
    options,
    methods,
    requests,
  );
  const assertCurrent = () => {
    if (!active) throw new Error("Disposed connector activation");
  };
  releases.push(
    bindNativeProviderTransport({
      fetch: fetcher,
      settleCredentialMutation: fetcher,
      assertCurrent,
    }),
  );
  releases.push(registerNativeProviderCleanup(providerId, nativeMcpCleanup));
  const draft: NativeDriverInput = {
    providerId,
    displayName: "Provider MCP connection",
    method: "mcp",
    parameters: {},
    credentials: {},
    requestedScopes: { user: [] },
    targetIds: {},
  };
  const saved = await configureNativeMcpConnector(draft);
  id = saved.connectionId;
  return {
    id,
    saved,
    draft,
    requests,
    methods,
    navigate,
    disable: () => {
      active = false;
    },
  };
}
