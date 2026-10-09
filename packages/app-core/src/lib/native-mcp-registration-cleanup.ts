import type { NativeProviderTransport } from "./native-connector-transport.js";
import type { NativeMcpOAuthTarget } from "./native-mcp-oauth-target.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import {
  type NativeMcpRegisteredClient,
  nativeMcpRegistrationManagementUrl,
} from "./native-mcp-registration-receipt.js";

/** RFC7592 deletes only the exact sealed management URI admitted under its DCR endpoint. */
export async function deleteNativeMcpRegistration(
  target: NativeMcpOAuthTarget,
  client: NativeMcpRegisteredClient,
  transport: NativeProviderTransport,
): Promise<boolean> {
  if (!client.registration_access_token && !client.registration_client_uri)
    return false;
  const url = nativeMcpRegistrationManagementUrl(target, client);
  transport.assertCurrent();
  const response = await transport.fetch(url, {
    method: "DELETE",
    credentials: "omit",
    redirect: "manual",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${client.registration_access_token}` },
  });
  await response.body?.cancel();
  transport.assertCurrent();
  if (
    response.status === 204 ||
    response.status === 404 ||
    response.status === 410
  )
    return true;
  throw new NativeMcpAuthError("authorization");
}
