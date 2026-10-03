/**
 * What a session does with its carriers and ICE servers, stated without any
 * session's state (ADR 0150 §6): the settings the browser takes, opening the
 * carriers a link names, and posting a code once one is up.
 */

import { type CarrierFactory, Rendezvous } from "./rendezvous.js";
import type { CarrierSpec, IceServerSpec } from "./transport.js";

/** How long a first post waits for a carrier to connect. */
const CARRIER_WAIT_MS = 8000;

export function rtcServers(servers: readonly IceServerSpec[]): RTCIceServer[] {
  return servers.map((server) => {
    const out: RTCIceServer = { urls: [...server.urls] };
    if (server.username) out.username = server.username;
    if (server.credential) out.credential = server.credential;
    return out;
  });
}

/** Open the carriers, if any are named and the shell supplied them. */
export function openCarriers(
  specs: readonly CarrierSpec[],
  secret: string,
  factory: CarrierFactory | undefined,
  onCode: (code: string) => void,
): Rendezvous | null {
  if (!factory || specs.length === 0) return null;
  return Rendezvous.open(specs, secret, factory, onCode);
}

/** Post once a carrier is up (or has had its chance). */
export function poster(
  rendezvous: Rendezvous,
): (code: string) => Promise<void> {
  return async (code) => {
    await rendezvous.whenReady(CARRIER_WAIT_MS);
    await rendezvous.post(code);
  };
}
