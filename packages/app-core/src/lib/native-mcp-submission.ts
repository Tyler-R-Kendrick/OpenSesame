/** Persist a no-replay boundary before an issuance request can leave this process. */
import { updateNativeConnector } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

export async function markNativeMcpSubmitting(
  id: string,
  intentId: string,
): Promise<void> {
  const current = requireNativeMcpRecord(id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    MCP_CLASSIFICATION,
    (record) => {
      const entry = record.privateState.recovery.find(
        (item) => item.id === intentId,
      );
      if (!entry || entry.credentials?.submission !== "prepared")
        throw new NativeMcpAuthError("pending");
      entry.credentials.submission = "submitting";
      return record;
    },
  );
}

export async function discardUnsubmittedExchange(
  id: string,
  intentId: string,
): Promise<void> {
  const current = requireNativeMcpRecord(id);
  if (!current.privateState.recovery.some((entry) => entry.id === intentId))
    return;
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    MCP_CLASSIFICATION,
    (record) => {
      record.privateState.recovery = record.privateState.recovery.filter(
        (entry) =>
          entry.id !== intentId ||
          entry.credentials?.phase !== "exchange" ||
          entry.credentials?.submission !== "prepared",
      );
      return record;
    },
  );
}
export function trackExchange(
  transport: NativeProviderTransport,
  endpoint: string,
  submitted: () => Promise<void>,
): NativeProviderTransport {
  const track =
    (send: typeof fetch): typeof fetch =>
    async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && request.url === endpoint)
        await submitted();
      return send(request);
    };
  const result = { ...transport, fetch: track(transport.fetch) };
  if (transport.settleCredentialMutation)
    result.settleCredentialMutation = track(transport.settleCredentialMutation);
  return result;
}
