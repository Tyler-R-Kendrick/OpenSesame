/** A real MCP initialize/tools-list proof precedes OAuth grant activation. */
import type { JsonObject } from "@opensesame/os-domain";
import { updateNativeConnector } from "./native-connector-store.js";
import type {
  NativeMcpDiscovery,
  NativeMcpToolResult,
} from "./native-mcp-protocol.js";
import {
  type NativeOAuthClientOwner,
  assertNativeOAuthClientPolicy,
  nativeOAuthClientClassification,
} from "./native-oauth-client-config.js";
import { commitNativeOAuthGrant } from "./native-oauth-commit.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeOAuthMcpResource } from "./native-oauth-mcp-resource.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
export async function verifyNativeOAuthMcpResource(
  id: string,
  owner: NativeOAuthClientOwner,
  signal?: AbortSignal,
) {
  const record = requireNativeOAuthRecord(id);
  assertNativeOAuthClientPolicy(record.configuration, owner);
  const retained = record.privateState.recovery.filter(
    (item) => item.credentials?.phase === "verify",
  );
  const intent = retained[0];
  if (
    record.privateState.recovery.length &&
    (retained.length !== 1 ||
      !intent?.grant ||
      intent.credentials?.protocol_valid !== "true")
  )
    throw new NativeOAuthError("cleanup");
  if (Object.keys(record.privateState.pending).length)
    throw new NativeOAuthError("cleanup");
  const grant = intent?.grant ?? record.privateState.grants.user;
  if (!grant) throw new NativeOAuthError("expired");
  const resource = nativeOAuthMcpResource(id, grant, owner, signal);
  try {
    const discovery = await resource.session.connect();
    resource.privateResult(discovery);
    resource.check();
    const verification = {
      identity: {
        id: resource.binding.resource,
        label: discovery.server.name,
        kind: "mcp-resource",
        assurance: "credential-valid" as const,
      },
      targets: [
        {
          id: resource.binding.resource,
          label: discovery.server.name,
          kind: "mcp-resource",
        },
      ],
      scopes: grant.scopes,
    };
    const view = intent
      ? await commitNativeOAuthGrant(
          id,
          intent.id,
          verification,
          nativeOAuthClientClassification,
          resource.transport,
          { revision: record.revision, grant },
        )
      : await updateNativeConnector(
          id,
          nativeOAuthGuard(record),
          nativeOAuthClientClassification(),
          (current) => {
            resource.check();
            const verifiedAt = Math.max(
              Date.now(),
              (current.runtime.verifiedAt ?? 0) + 1,
            );
            current.privateState.verification = {
              fingerprint: current.configuration.fingerprint,
              verifiedAt,
              kind: "provider",
            };
            current.runtime.verifiedAt = verifiedAt;
            current.runtime.identity = verification.identity;
            current.runtime.targets = verification.targets;
            return current;
          },
          resource.check,
        );
    return { view, discovery };
  } finally {
    await resource.dispose();
  }
}
async function operation<T extends NativeMcpDiscovery | NativeMcpToolResult>(
  id: string,
  owner: NativeOAuthClientOwner,
  action: (resource: ReturnType<typeof nativeOAuthMcpResource>) => Promise<T>,
  signal?: AbortSignal,
) {
  const record = requireNativeOAuthRecord(id);
  assertNativeOAuthClientPolicy(record.configuration, owner);
  const grant = record.privateState.grants.user;
  if (
    !grant ||
    !record.privateState.verification ||
    record.runtime.identity?.kind !== "mcp-resource" ||
    record.privateState.recovery.length ||
    Object.keys(record.privateState.pending).length
  )
    throw new NativeOAuthError("expired");
  const resource = nativeOAuthMcpResource(id, grant, owner, signal);
  try {
    const discovery = await resource.session.connect();
    resource.privateResult(discovery);
    const result = await action(resource);
    resource.privateResult(result);
    resource.check();
    return result;
  } finally {
    await resource.dispose();
  }
}
export function listNativeOAuthMcpTools(
  id: string,
  owner: NativeOAuthClientOwner,
  signal?: AbortSignal,
) {
  return operation(id, owner, (resource) => resource.session.connect(), signal);
}
export function invokeNativeOAuthMcpTool(
  id: string,
  name: string,
  args: JsonObject,
  owner: NativeOAuthClientOwner,
  signal?: AbortSignal,
) {
  return operation(
    id,
    owner,
    (resource) => resource.session.callTool(name, args, signal),
    signal,
  );
}
