/**
 * Sealing a joiner's ask into its request code. Split from `guest.ts`
 * for the module-size budget (ADR 0093).
 */

import type { JoinPeerBlock } from "./join-peer.js";
import type { LiveLink } from "./link.js";
import { type SeatKind, type SeatRoute, cleanText } from "./messages.js";
import { makeRequestCode } from "./pairing.js";
import { joinRequestWithPeer } from "./peer-trust-join.js";
import type { Keypair } from "./seal.js";

/** Seal one join request, with its peer block, into its request code. */
export async function makeJoinRequestCode(
  link: LiveLink,
  code: string | null,
  keys: Keypair,
  ask: Readonly<{
    id: string;
    name: string;
    note: string;
    offer: string;
    kind?: SeatKind | undefined;
    route?: SeatRoute | undefined;
  }>,
  peer: JoinPeerBlock | undefined,
): Promise<string> {
  return makeRequestCode(
    link,
    code,
    keys,
    joinRequestWithPeer(
      {
        id: ask.id,
        name: cleanText(ask.name),
        note: cleanText(ask.note),
        offer: ask.offer,
        greets: true,
        kind: ask.kind ?? "person",
        route: ask.route ?? "peer",
      },
      peer,
    ),
  );
}
