/** Only an attempted DCR mutation creates uncertainty; metadata reads cannot create clients. */
import type { NativeRecovery } from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  NativeMcpAuthError,
  type NativeMcpOAuthTarget,
} from "./native-mcp-oauth-target.js";
import { NativeMcpPublicOAuth } from "./native-mcp-oauth.js";
import {
  discardNativeMcpRegistration,
  reserveNativeMcpRegistration,
  retainNativeMcpRegistration,
} from "./native-mcp-registration.js";

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
    // A "storage" failure after submission keeps the obligation and the
    // retained registration, so a retry seals it instead of minting another.
    const fatalReceipt =
      submitted &&
      error instanceof NativeMcpAuthError &&
      error.code === "metadata";
    if (!submitted || fatalReceipt)
      await discardNativeMcpRegistration(id, obligation.id);
    throw error;
  }
}
