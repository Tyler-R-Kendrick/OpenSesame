import { retryNativeConnectorCleanup } from "./native-connector-lifecycle.js";
import { updateNativeConnector } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

export async function prepareNativeMcpAuthorization(
  id: string,
  transport: NativeProviderTransport,
): Promise<void> {
  const current = requireNativeMcpRecord(id);
  const resumable =
    current.privateState.recovery.length === 1 &&
    current.privateState.recovery[0]?.kind === "registration" &&
    current.privateState.recovery[0]?.credentials?.phase === "registered" &&
    !!current.privateState.credentials.mcp_client;
  if (
    (current.privateState.recovery.length > 0 && !resumable) ||
    Object.keys(current.privateState.pending).length
  )
    throw new Error(
      "Finish MCP authorization or provider cleanup before starting another consent",
    );
  const grant = current.privateState.grants.user;
  if (!grant) return;
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    MCP_CLASSIFICATION,
    (record) => {
      transport.assertCurrent();
      const targetId =
        grant.resource ?? grant.targetId ?? record.configuration.providerId;
      record.privateState.recovery.push({
        id: `reconsent:${crypto.randomUUID()}`,
        kind: "revoke",
        providerId: grant.providerId,
        actor: grant.actor,
        fingerprint: grant.fingerprint,
        targetId,
        grant: { ...grant, targetId },
        credentials: {
          mcp_client: record.privateState.credentials.mcp_client ?? "",
        },
      });
      record.privateState.grants = {};
      record.privateState.verification = null;
      record.runtime.grants = [];
      return record;
    },
  );
  await retryNativeConnectorCleanup(id);
}
