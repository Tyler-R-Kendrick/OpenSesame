/**
 * The addresses a live session names for itself (ADR 0150 §6, amended
 * 2026-10-24).
 *
 * A received description loses every candidate at a loopback, private,
 * link-local or otherwise non-public literal (`sdp.ts`), so a peer cannot
 * steer this browser's ICE checks at an internal host. The exceptions are
 * exactly the addresses the session itself names, compared as canonical IP
 * literals and never resolved:
 *
 * - the same-machine hints every session offers (`SAME_MACHINE_HINTS`);
 * - on the owner's side, the addresses the owner named in Routes;
 * - on the joiner's side, the addresses the owner's reply names, sealed to
 *   that one joiner (`JoinReply.addresses`). A reply without them, from
 *   before this, admits only the same-machine hints.
 */

import { type JsonValue, isString } from "@opensesame/os-domain";
import { SAME_MACHINE_HINTS } from "./candidates.js";
import type { ReplyPeerBlock } from "./join-peer.js";
import type { JoinReply } from "./messages.js";
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

/** The canonical forms of `addresses`, once each, at most the reply bound. */
export function canonicalAddresses(addresses: readonly string[]): string[] {
  const out = new Set<string>();
  for (const address of addresses) {
    const canonical = canonicalAddress(address);
    if (canonical !== null) out.add(canonical);
  }
  return [...out].slice(0, NAMED_ADDRESSES_MAX);
}

/**
 * What a received description may name although it is not public: the
 * addresses this side's session names, and the same-machine hints.
 */
export function sessionNamedAddresses(
  named: readonly string[],
): ReadonlySet<string> {
  return new Set(canonicalAddresses([...named, ...SAME_MACHINE_HINTS]));
}

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
 * offers as hints; a relay seat has no answer and names none.
 */
export function withNamedAddresses(
  reply: JoinReply,
  named: readonly string[] | undefined,
): JoinReply {
  if (!named?.length || reply.answer === "") return reply;
  return { ...reply, addresses: canonicalAddresses(named) };
}
