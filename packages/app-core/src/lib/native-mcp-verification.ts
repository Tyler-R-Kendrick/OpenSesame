import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { verifyNativeMcpRecord } from "./native-mcp-proof.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { refreshNativeMcpAuthorization } from "./native-mcp-refresh.js";
export { activateNativeMcpGrant } from "./native-mcp-proof.js";

export async function verifyNativeMcpConnector(
  id: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  transport.assertCurrent();
  const record = requireNativeMcpRecord(id);
  if (
    record.privateState.recovery.length ||
    Object.keys(record.privateState.pending).length
  )
    throw new Error(
      "Finish MCP authorization or cleanup before verifying this connector",
    );
  const grant = record.privateState.grants.user;
  if (
    grant?.refreshToken &&
    grant.expiresAt !== null &&
    grant.expiresAt <= Date.now()
  )
    return refreshNativeMcpAuthorization(record, transport);
  return verifyNativeMcpRecord(record, transport);
}
