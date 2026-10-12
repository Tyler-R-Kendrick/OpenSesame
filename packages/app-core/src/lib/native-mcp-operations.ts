import type { JsonObject } from "@opensesame/os-domain";
import { assertNativeBrowserMcpPolicy } from "./native-browser-policy.js";
import { assertNativeConnectorRevision } from "./native-connector-store.js";
import { readNativeConnector } from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import type {
  NativeMcpDiscovery,
  NativeMcpSession,
} from "./native-mcp-protocol.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { nativeMcpRecordSession } from "./native-mcp-session.js";
import { NativeMcpError } from "./native-mcp-target.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

import { assertNativeMcpResultPrivate } from "./native-mcp-result.js";

async function operation<T>(
  id: string,
  action: (
    session: NativeMcpSession,
    discovery: NativeMcpDiscovery,
  ) => Promise<T>,
  transport: NativeProviderTransport,
): Promise<T> {
  if (readNativeConnector(id)?.status !== "connected")
    throw new NativeMcpError("authorization");
  transport.assertCurrent();
  const record = requireNativeMcpRecord(id);
  assertNativeBrowserMcpPolicy(record.configuration.providerId);
  const session = await nativeMcpRecordSession(record, transport);
  try {
    const discovery = await session.connect();
    assertNativeMcpResultPrivate(record, JSON.stringify(discovery));
    await assertNativeConnectorRevision(id, nativeOAuthGuard(record));
    transport.assertCurrent();
    const result = await action(session, discovery);
    await assertNativeConnectorRevision(id, nativeOAuthGuard(record));
    transport.assertCurrent();
    return result;
  } finally {
    await session.dispose();
  }
}
export function listNativeMcpTools(
  id: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  return operation(id, async (_session, discovery) => discovery, transport);
}
export function invokeNativeMcpTool(
  id: string,
  name: string,
  arguments_: JsonObject,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  return operation(
    id,
    async (session) => {
      const result = await session.callTool(name, arguments_);
      assertNativeMcpResultPrivate(
        requireNativeMcpRecord(id),
        JSON.stringify(result),
      );
      return result;
    },
    transport,
  );
}
