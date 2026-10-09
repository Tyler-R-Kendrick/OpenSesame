import type { NativeRecovery } from "./native-connector-schema.js";
/** Only an attempted DCR mutation creates uncertainty; metadata reads cannot create clients. */
import { updateNativeConnector } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import type { NativeMcpOAuthTarget } from "./native-mcp-oauth-target.js";
import { NativeMcpPublicOAuth } from "./native-mcp-oauth.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import {
  forgetRetainedNativeMcpRegistration,
  reserveNativeMcpRegistration,
  retainNativeMcpRegistration,
} from "./native-mcp-registration.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

export async function admitNativeMcpRegistration(
  id: string,
  obligation: NativeRecovery,
  target: NativeMcpOAuthTarget,
  transport: NativeProviderTransport,
) {
  reserveNativeMcpRegistration(id, obligation.id, target.binding.fingerprint);
  let submitted = false;
  const observe =
    (admitted: typeof fetch): typeof fetch =>
    async (input, init) => {
      const request = new Request(input, init);
      if (
        request.method === "POST" &&
        request.url === target.metadata.registrationEndpoint
      )
        submitted = true;
      return admitted(request);
    };
  const ports = {
    ...transport,
    signal: new AbortController().signal,
    fetch: observe(transport.fetch),
  };
  if (transport.settleCredentialMutation)
    ports.settleCredentialMutation = observe(
      transport.settleCredentialMutation,
    );
  const protocol = new NativeMcpPublicOAuth(target, ports);
  try {
    return await protocol.register((registered) =>
      retainNativeMcpRegistration(
        id,
        obligation.id,
        target.binding.fingerprint,
        registered,
      ),
    );
  } catch (error) {
    if (!submitted) {
      const current = requireNativeMcpRecord(id);
      await updateNativeConnector(
        id,
        nativeOAuthGuard(current),
        MCP_CLASSIFICATION,
        (record) => {
          record.privateState.recovery = record.privateState.recovery.filter(
            (entry) => entry.id !== obligation.id,
          );
          return record;
        },
      );
      forgetRetainedNativeMcpRegistration(id, obligation.id);
    }
    throw error;
  }
}
