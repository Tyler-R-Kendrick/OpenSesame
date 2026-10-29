/** Browser-realm fixture: synthetic OAuth responses, real OPFS, IndexedDB and Web Locks. */
import { browserPorts } from "@opensesame/app-core/browser/host.js";
import { composeHost, configureHost } from "@opensesame/app-core/host.js";
import { atRestReady } from "@opensesame/app-core/lib/at-rest/key.js";
import { DEVICE_CONNECTOR_KEYS } from "@opensesame/app-core/lib/device-connector-records.js";
import { kvDurability, kvHydrate } from "@opensesame/app-core/lib/kv.js";
import { bindNativeBrowserPolicyOrigin } from "@opensesame/app-core/lib/native-browser-policy.js";
import {
  attestNativeMcpRevocation,
  nativeMcpRevocationInstructions,
} from "@opensesame/app-core/lib/native-mcp-attestation.js";
import {
  beginNativeMcpAuthorization,
  finishNativeMcpAuthorization,
} from "@opensesame/app-core/lib/native-mcp-authorization.js";
import { prepareNativeMcpCleanup } from "@opensesame/app-core/lib/native-mcp-cleanup.js";
import { configureNativeMcpConnector } from "@opensesame/app-core/lib/native-mcp-config.js";
import { nativeMcpRecordOAuthTarget } from "@opensesame/app-core/lib/native-mcp-profile.js";
import { requireNativeMcpRecord } from "@opensesame/app-core/lib/native-mcp-records.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import type { JsonObject } from "@opensesame/os-domain";

let blockedAt: "prepared" | "submitting" | null = null;
let held = false;
let tokenPosts = 0;
let failure: string | null = null;
let connection = "";
const never = () => new Promise<Response>(() => {});
const reply = (value: JsonObject, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const transport = {
  assertCurrent: () => {},
  fetch: async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const target = nativeMcpRecordOAuthTarget(
      requireNativeMcpRecord(connection).configuration,
    );
    const m = target.metadata;
    if (blockedAt === "prepared" && request.method === "GET") {
      held = true;
      return never();
    }
    if (request.url === m.resourceMetadata)
      return reply({
        resource: target.binding.resource,
        authorization_servers: [target.binding.issuer],
      });
    if (request.url === m.discoveryUrl)
      return reply({
        issuer: target.binding.issuer,
        authorization_endpoint: m.authorizationEndpoint,
        token_endpoint: m.tokenEndpoint,
        registration_endpoint: m.registrationEndpoint,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    if (request.url === m.registrationEndpoint)
      return reply(
        {
          client_id: "realm-test-client",
          redirect_uris: [target.redirectUri],
          token_endpoint_auth_method: "none",
          registration_client_uri: `${m.registrationEndpoint}/realm-test-client`,
          registration_access_token: "realm-test-management",
        },
        201,
      );
    if (request.url === m.tokenEndpoint) {
      tokenPosts++;
      if (blockedAt === "submitting") {
        held = true;
        return never();
      }
      throw new Error("Unexpected token request");
    }
    throw new Error("Unexpected fixture destination");
  },
};
const actualTransport = {
  ...transport,
  settleCredentialMutation: transport.fetch,
};
export async function setup() {
  const host = composeHost(browserPorts(), {
    env: { BASE_URL: "/", DEV: false },
  });
  configureHost(host);
  const key = await atRestReady();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  if (
    !key.durable ||
    kvDurability() !== "persistent" ||
    host.locks !== navigator.locks
  )
    throw new Error("Native persistent storage and Web Locks are required");
  bindNativeBrowserPolicyOrigin(() => "https://self-host.example.org");
  bindNativeOAuthBrowserPort({
    redirectUri: "https://self-host.example.org/auth/native-connector.html",
    navigate: () => {},
    scrubCallback: () => {},
  });
  return {
    durability: kvDurability(),
    nativeLocks: host.locks === navigator.locks,
  };
}
export async function sync() {
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
}
export async function start() {
  const saved = await configureNativeMcpConnector(
    {
      providerId: "adobe",
      displayName: "MCP realm test",
      method: "mcp",
      parameters: {},
      credentials: {},
      requestedScopes: { user: [] },
      targetIds: {},
    },
    actualTransport,
  );
  connection = saved.connectionId;
  await beginNativeMcpAuthorization(connection, "user", actualTransport);
  return {
    id: connection,
    state: requireNativeMcpRecord(connection).privateState.pending.user.state,
  };
}
export function startFinish(
  id: string,
  state: string,
  stage: "prepared" | "submitting",
) {
  connection = id;
  blockedAt = stage;
  void finishNativeMcpAuthorization(
    `?native_state=${encodeURIComponent(state)}&native_code=realm-test-code`,
    actualTransport,
  ).catch(() => {
    failure = "authorization failed";
  });
}
export function status() {
  return { stage: held ? blockedAt : "running", tokenPosts, failure };
}
export async function prepare(id: string) {
  await prepareNativeMcpCleanup(id);
}
export function inspect(id: string) {
  const record = requireNativeMcpRecord(id);
  return {
    durability: kvDurability(),
    revision: record.revision,
    clientPresent: !!record.privateState.credentials.mcp_client,
    recovery: record.privateState.recovery.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      phase: entry.credentials?.phase,
      submission: entry.credentials?.submission,
    })),
  };
}
export async function guide(id: string) {
  const entry = requireNativeMcpRecord(id).privateState.recovery.find(
    (item) => item.credentials?.phase === "exchange",
  );
  if (!entry) throw new Error("No exchange intent");
  return nativeMcpRevocationInstructions(id, entry.id);
}

export async function attest(id: string, intentId: string, revision: number) {
  await attestNativeMcpRevocation(id, intentId, revision);
}
