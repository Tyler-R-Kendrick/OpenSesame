/**
 * What a session does with its carriers and routes, stated without any
 * session's state (ADR 0150 §6): the routing its link takes, opening the
 * carriers a link names, and posting a code once one is up.
 */

import type { GuestCarriers } from "./guest.js";
import { sessionOver } from "./nats-route.js";
import type { PeerRouting } from "./p2p.js";
import {
  type CarrierFactory,
  type CarrierRole,
  Rendezvous,
  carrierTopic,
} from "./rendezvous.js";
import { newLinkSecret } from "./seal.js";
import {
  type CarrierSpec,
  type LiveTransport,
  sessionRoutes,
} from "./transport.js";

/** How long a first post waits for a carrier to connect. */
const CARRIER_WAIT_MS = 8000;

/** Open the carriers, if any are named and the shell supplied them. */
export function openCarriers(
  specs: readonly CarrierSpec[],
  secret: string,
  factory: CarrierFactory | undefined,
  onCode: (code: string) => void,
  role: CarrierRole = "joiner",
): Rendezvous | null {
  if (!factory || specs.length === 0) return null;
  return Rendezvous.open(specs, secret, factory, onCode, role);
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

/**
 * What a joiner holds of the link's carriers: post the request, close them,
 * and — when a NATS carrier may carry the session — open a seat's channel
 * there (ADR 0167).
 */
export function guestCarriersFor(rendezvous: Rendezvous): GuestCarriers {
  const relaying = rendezvous.states
    .map((state) => sessionOver(state.spec))
    .find((session) => session !== "off");
  return {
    post: poster(rendezvous),
    close: () => rendezvous.close(),
    seat: (name) => rendezvous.seat(name),
    session: relaying ?? "off",
  };
}

/**
 * A new session's link secret, the routes its link carries, the carriers the
 * owner keeps, and how the owner's side of each link may route. The secret
 * comes first: a NATS credential is minted for its topic (ADR 0167).
 */
export async function hostRoutes(transport: LiveTransport, expiresAt: number) {
  const secret = newLinkSecret();
  const { link: routes, own } = await sessionRoutes(
    transport,
    expiresAt,
    await carrierTopic(secret),
  );
  const routing: PeerRouting = {
    servers: routes.ice,
    relay: transport.relay,
    addresses: transport.addresses,
  };
  return { secret, routes, own, routing };
}
