/** Only an attempted DCR mutation creates uncertainty; metadata reads cannot create clients. */
import type { NativeRecovery } from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import type { NativeMcpRegistrationMode } from "./native-mcp-oauth-metadata.js";
import type { NativeMcpOAuthTarget } from "./native-mcp-oauth-target.js";
import { NativeMcpPublicOAuth } from "./native-mcp-oauth.js";
import {
  discardNativeMcpRegistration,
  reserveNativeMcpRegistration,
  retainNativeMcpRegistration,
} from "./native-mcp-registration.js";
import { markNativeMcpSubmitting } from "./native-mcp-submission.js";

export async function admitNativeMcpRegistration(
  id: string,
  obligation: NativeRecovery,
  target: NativeMcpOAuthTarget,
  transport: NativeProviderTransport,
) {
  reserveNativeMcpRegistration(id, obligation.id, target.binding.fingerprint);
  let submitted = false;
  let mode: NativeMcpRegistrationMode | null = null;
  const observe =
    (admitted: typeof fetch): typeof fetch =>
    async (input, init) => {
      const request = new Request(input, init);
      if (
        request.method === "POST" &&
        request.url === target.metadata.registrationEndpoint
      ) {
        await markNativeMcpSubmitting(id, obligation.id);
        submitted = true;
      }
      return admitted(request);
    };
  const ports = {
    ...transport,
    signal: new AbortController().signal,
    onRegistrationMode: (selected: NativeMcpRegistrationMode) => {
      mode = selected;
    },
    fetch: observe(transport.fetch),
  };
  if (transport.settleCredentialMutation)
    ports.settleCredentialMutation = observe(
      transport.settleCredentialMutation,
    );
  const protocol = new NativeMcpPublicOAuth(target, ports);
  try {
    return await protocol.register((registered) => {
      if (!mode) throw new Error("Missing registration mode");
      return retainNativeMcpRegistration(
        id,
        obligation.id,
        target.binding.fingerprint,
        registered,
        mode,
      );
    });
  } catch (error) {
    // A "storage" failure after submission keeps the obligation and the
    // retained registration, so a retry seals it instead of minting another.
    if (!submitted) await discardNativeMcpRegistration(id, obligation.id);
    throw error;
  }
}
