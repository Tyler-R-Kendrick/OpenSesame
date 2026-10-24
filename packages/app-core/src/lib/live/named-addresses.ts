/**
 * The addresses a live session's person authorized (ADR 0150 §6, amended
 * 2026-10-24).
 *
 * A received description loses every candidate at a loopback, private,
 * link-local or otherwise non-public literal (`sdp.ts`), so a peer cannot
 * steer this browser's ICE checks at an internal host. It keeps one only at
 * an address this side's person authorized, compared as a canonical IP
 * literal and never resolved:
 *
 * - the addresses this side named itself in Routes, loopback included only
 *   when Routes name it (this machine, off by default);
 * - on the joiner's side, the addresses the owner's reply names
 *   (`JoinReply.addresses`) once the joiner allowed them. Approving the owner
 *   is not authorizing the owner's targets: the reply is sealed by the owner,
 *   so it proves who named them, not that this browser may probe them;
 * - for a relay candidate only, the literal host of a TURN server this side
 *   already authorized: its own Routes, or the link's servers the joiner was
 *   shown before anything was contacted. A TURN server a person runs on their
 *   own network relays from its own address.
 */

import { type JsonValue, isString } from "@opensesame/os-domain";
import type { ReplyPeerBlock } from "./join-peer.js";
import type { JoinReply } from "./messages.js";
import type { IceServerSpec } from "./routes.js";
import { isAddress } from "./transport.js";

/** The most addresses a reply may name: as many as Routes can hold. */
export const NAMED_ADDRESSES_MAX = 8;

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * An IP literal in the one form every spelling of it shares: IPv4 as the
 * reader admits it (no leading zeros), IPv6 as the URL parser prints it.
 * Null for anything else, a host name included: an address is compared,
 * never resolved.
 */
export function canonicalAddress(value: string): string | null {
  if (IPV4.test(value)) return value;
  if (!IPV6.test(value) || !value.includes(":")) return null;
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** The canonical forms of `addresses`, once each. */
export function canonicalAddresses(addresses: readonly string[]): string[] {
  const out = new Set<string>();
  for (const address of addresses) {
    const canonical = canonicalAddress(address);
    if (canonical !== null) out.add(canonical);
  }
  return [...out];
}

/** What a received description may name although it is not public. */
export type CandidateAllowlist = Readonly<{
  /** Any candidate at one of these. */
  addresses: ReadonlySet<string>;
  /** A relay candidate at one of these. */
  relays: ReadonlySet<string>;
}>;

/** A TURN URL's host: bracketed IPv6, or up to the port or query. */
const TURN_HOST =
  /^turns?:(\[[^\]]{1,64}\]|[^:?/\[\]]{1,253})(?::\d{1,5})?(?:\?|$)/iu;

/**
 * The hosts of the TURN servers among `servers` that are IP literals, in
 * canonical form. A TURN server named by a host name contributes none: an
 * address is compared, never resolved. A STUN server relays nothing.
 */
export function turnServerHosts(
  servers: readonly Pick<IceServerSpec, "urls">[],
): string[] {
  const out = new Set<string>();
  for (const server of servers)
    for (const url of server.urls) {
      const host = TURN_HOST.exec(url)?.[1]?.replace(/^\[|\]$/gu, "");
      const canonical = host === undefined ? null : canonicalAddress(host);
      if (canonical !== null) out.add(canonical);
    }
  return [...out];
}

/**
 * What a received description may name although it is not public: the
 * addresses this side's person authorized (`named`), and, for a relay
 * candidate, the literal hosts of the TURN servers among `servers`. Nothing
 * is added by default, loopback included.
 */
export function sessionNamedAddresses(
  named: readonly string[],
  servers: readonly Pick<IceServerSpec, "urls">[] = [],
): CandidateAllowlist {
  return {
    addresses: new Set(canonicalAddresses(named)),
    relays: new Set(turnServerHosts(servers)),
  };
}

/** Nothing named: every non-public literal is dropped. */
export const NOTHING_NAMED: CandidateAllowlist = {
  addresses: new Set<string>(),
  relays: new Set<string>(),
};

/**
 * A reply's `addresses`, read strictly: absent (undefined), or an array of
 * at most `NAMED_ADDRESSES_MAX` usable IP literals, each already canonical.
 * Anything else is null, and refuses the whole reply.
 */
export function readNamedAddresses(
  value: JsonValue | undefined,
): readonly string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > NAMED_ADDRESSES_MAX) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (!isString(entry) || !isAddress(entry)) return null;
    if (canonicalAddress(entry) !== entry) return null;
    out.push(entry);
  }
  return out;
}

/** A reply as read: the fields it carried, and nothing it did not. */
export function joinReply(
  id: string,
  answer: string,
  peer: ReplyPeerBlock | undefined,
  relay: boolean,
  addresses?: readonly string[],
): JoinReply {
  const reply: JoinReply = relay
    ? { id, answer, relay: "nats" }
    : { id, answer };
  const signed = peer ? { ...reply, peer } : reply;
  return addresses?.length ? { ...signed, addresses } : signed;
}

/**
 * The owner's reply with the addresses it named in Routes, which its answer
 * offers as hints, for the joiner to allow; a relay seat has no answer and
 * names none.
 */
export function withNamedAddresses(
  reply: JoinReply,
  named: readonly string[] | undefined,
): JoinReply {
  if (!named?.length || reply.answer === "") return reply;
  const addresses = canonicalAddresses(named).slice(0, NAMED_ADDRESSES_MAX);
  return { ...reply, addresses };
}
