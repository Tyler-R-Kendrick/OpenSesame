/**
 * What the Host grant this browser holds lets it do (ADR 0151).
 *
 * A pairing grant is narrower than "approved": the sync ceiling carries
 * `host.sync.*` and the join ceiling `host.join` (browser-pairing.ts), while
 * creating a connection or writing its credential needs
 * `host.connections.write` (the gateway's browser-user route table). A road
 * that saves through the Host is open only when the grant carries the
 * capability that road's routes require.
 */

import { currentBrowserGrant } from "./browser-pairing.js";
import { hostBase } from "./identity.js";

/** The capability the gateway requires to create or change a connection. */
export const HOST_CONNECTIONS_WRITE = "host.connections.write";

export const hostGrantSeams = {
  /** Capabilities of the live grant for `hostApi`, or none. */
  capabilities: (hostApi: string): readonly string[] =>
    currentBrowserGrant(hostApi)?.capabilities ?? [],
};

/** A Host is named and the live approved grant to it carries `capability`. */
export function hostGrantAllows(capability: string): boolean {
  const base = hostBase();
  return base !== "" && hostGrantSeams.capabilities(base).includes(capability);
}
