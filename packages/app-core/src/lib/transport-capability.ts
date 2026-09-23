/**
 * The browser boundary as a typed answer (BROWSER-BOUNDARY, AT-BROWSER-KEY).
 *
 * A connection whose transport needs a vault-controlled TLS identity cannot
 * be executed from a page: `fetch` takes no certificate, a vault key has no
 * road into the handshake, and there is no proxy to hand it to. The answer
 * is the typed outcome below — never an export, never a silent fallback.
 * A browser-managed profile is the one exception, and even then the browser
 * presents whatever its OS holds; this app selects nothing.
 */
import type { TransportPolicy } from "./transport-model.js";
import type {
  BrowserManagedProfile,
  TransportExecutionTarget,
} from "./transport-settings.js";

/** What a connection asks of its transport, as far as a page needs to know. */
export type TransportRequirement = {
  executionTarget?: TransportExecutionTarget;
  desiredPolicy?: TransportPolicy;
  identityRef?: { name: string };
  browserProfile?: BrowserManagedProfile;
};

export type BrowserExecutionOutcome =
  | { outcome: "supported" }
  | {
      outcome: "unsupported_in_browser";
      code: "source_unsupported";
      reason: string;
    };

const UNSUPPORTED = (reason: string): BrowserExecutionOutcome => ({
  outcome: "unsupported_in_browser",
  code: "source_unsupported",
  reason,
});

/** True when the connection's transport wants a key the browser must not hold. */
export function needsVaultControlledIdentity(
  transport: TransportRequirement | undefined,
): boolean {
  if (!transport) return false;
  if (transport.browserProfile?.kind === "browser_managed") return false;
  return (
    transport.identityRef !== undefined ||
    transport.desiredPolicy === "mtls_required"
  );
}

/**
 * Gate a client-side invoke. Call this before any connector request leaves
 * the page; an `unsupported_in_browser` answer is the whole of what the
 * browser does with that connection.
 */
export function assertBrowserExecution(connection: {
  id?: string;
  transport?: TransportRequirement;
}): BrowserExecutionOutcome {
  const transport = connection.transport;
  if (!transport) return { outcome: "supported" };
  if (transport.executionTarget && transport.executionTarget !== "browser") {
    return UNSUPPORTED(
      `runs on ${transport.executionTarget}, not in this browser`,
    );
  }
  if (needsVaultControlledIdentity(transport)) {
    return UNSUPPORTED(
      "needs a vault-controlled tls identity, which a browser cannot present",
    );
  }
  return { outcome: "supported" };
}
