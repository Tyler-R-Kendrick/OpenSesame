import { secretBackendUrl } from "@opensesame/app-core/lib/secret-backends/http.js";
import type { SecretBackendDraft } from "@opensesame/app-core/lib/secret-backends/types.js";
import {
  subscribeTailscaleBrowserNode,
  tailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { TailscalePanels } from "../tailscale/TailscalePanels.js";

type PublicEndpointDraft = Pick<
  SecretBackendDraft,
  "mode" | "baseUrl" | "identityUrl"
>;
const noNode = () => null;
const localModes = new Set(["local", "file-import", "credential-management"]);

/** Exact configured origins only; account tokens never supply UI destinations. */
export function secretBackendHTTPOrigins(draft: PublicEndpointDraft) {
  if (localModes.has(draft.mode)) return null;
  const urls = [draft.baseUrl];
  if (["bitwarden-api", "bitwarden-secrets"].includes(draft.mode))
    urls.push(draft.identityUrl);
  const origins = new Set<string>();
  let complete = true;
  for (const value of urls) {
    try {
      const url = secretBackendUrl(value);
      if (draft.mode === "onepassword-sdk" && url.pathname !== "/")
        throw new Error("Account URL must be an origin.");
      origins.add(url.origin);
    } catch {
      complete = false;
    }
  }
  return { origins: [...origins], complete };
}

/** Compose the same saved route, vault custody and live node controls as Networking. */
export function SecretBackendHTTPRoute({
  draft,
  online,
  busy,
}: { draft: PublicEndpointDraft; online: boolean; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const node = useSyncExternalStore(
    subscribeTailscaleBrowserNode,
    tailscaleBrowserNode,
    noNode,
  );
  const target = secretBackendHTTPOrigins(draft);
  if (!target) return null;
  return (
    <details
      className="conn-client-alt"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>HTTPS connection route</summary>
      <p>
        Browser HTTPS uses this provider directly. To use the PWA's Tailscale
        browser node, configure its approved exit node for public endpoints or
        its approved peer for a tailnet service below.
      </p>
      {target.complete ? (
        <>
          <p>Approve these exact origins with their destination CIDRs:</p>
          <ul aria-label="Secret backend HTTPS origins">
            {target.origins.map((origin) => (
              <li key={origin}>
                <code>{origin}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          Complete the provider URLs above to identify all required origins.
        </p>
      )}
      <p>
        This is the shared browser-node configuration. Choose the route and TLS
        trust, save it and connect the node before connecting this provider.
        Disconnect the provider before changing its route, then reconnect it.
      </p>
      {open && !node ? (
        <p>
          <Link to="/settings/features#feature-networking">
            Configure Networking in Features
          </Link>{" "}
          to activate the browser node.
        </p>
      ) : null}
      {open && node ? (
        <fieldset className="cx-block" disabled={busy}>
          <legend>Shared HTTPS route configuration</legend>
          <TailscalePanels online={online} />
        </fieldset>
      ) : null}
    </details>
  );
}
