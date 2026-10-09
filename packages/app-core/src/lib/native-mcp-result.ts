/** A provider may return arbitrary tool data, but saved authorization stays private. */
import type { NativeConnectorRecord } from "./native-connector-store.js";
import { nativeMcpClient } from "./native-mcp-records.js";
import { NativeMcpError } from "./native-mcp-target.js";

export function assertNativeMcpResultPrivate(
  record: NativeConnectorRecord,
  encoded: string,
): void {
  const grant = record.privateState.grants.user;
  const secrets = [grant?.accessToken, grant?.refreshToken];
  if (record.privateState.credentials.mcp_client) {
    const client = nativeMcpClient(record);
    secrets.push(client.client_secret, client.registration_access_token);
  }
  if (
    secrets.some(
      (secret) =>
        !!secret && encoded.includes(JSON.stringify(secret).slice(1, -1)),
    )
  )
    throw new NativeMcpError("response");
}
