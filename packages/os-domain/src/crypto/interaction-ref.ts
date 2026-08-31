/**
 * Opaque, MAC-bound interaction references (ADR 0086).
 *
 * A reference is what goes on a screen: printed in a terminal, drawn as a QR,
 * embedded in a Google Wallet barcode, texted to a phone. It is read by
 * cameras, cached by browsers, and photographed by whoever is standing behind
 * you. So it is built to be worth nothing on its own.
 *
 * Two properties, and they do different jobs:
 *
 * 1. **Unguessable.** The id inside is 18 random bytes. Nobody enumerates the
 *    interaction space by counting.
 * 2. **MAC-bound.** A reference that was not minted here is rejected before
 *    any lookup happens. That is not a second line of defence for guessing —
 *    the randomness already handles that — it is what stops a caller turning
 *    the resolve endpoint into a database probe, and it means "no such
 *    interaction" and "not minted by us" are the same answer at the same cost.
 *
 * What a reference is *not* is a bearer. Holding one lets you ask what kind of
 * question is being asked and when it lapses. Answering the question needs an
 * authenticated approver and a proof bound to the request digest. Every other
 * property in this file is downstream of that one.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Domain separation: this MAC key is shared with other handle families. */
export const INTERACTION_REF_PURPOSE = "opensesame:interaction-ref:v1";

const PREFIX = "i_";
const TAG_LENGTH = 32;
/** 18 bytes → 144 bits of id entropy, base64url with no padding. */
const ID_BYTES = 18;

export interface MintedInteractionRef {
  /** The stored primary key. Never leaves the server. */
  id: string;
  /** The public handle. Safe to print, scan, and photograph. */
  ref: string;
}

function newInteractionId(): string {
  return `int_${randomBytes(ID_BYTES).toString("base64url")}`;
}

function tag(id: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update(`${INTERACTION_REF_PURPOSE}\0${id}`)
    .digest("base64url")
    .slice(0, TAG_LENGTH);
}

/** The public reference for an id that already exists. */
export function interactionRef(id: string, pepper: string): string {
  const body = Buffer.from(id, "utf8").toString("base64url");
  return `${PREFIX}${body}.${tag(id, pepper)}`;
}

/** A fresh id and its reference. */
export function mintInteractionRef(pepper: string): MintedInteractionRef {
  const id = newInteractionId();
  return { id, ref: interactionRef(id, pepper) };
}

/**
 * The id a reference addresses, or null.
 *
 * Null for a malformed reference, a forged MAC, and a reference for an
 * interaction that never existed alike. The caller must map all three to one
 * response: a resolve endpoint that distinguishes them is an oracle for which
 * references are real.
 */
export function resolveInteractionRef(
  ref: string,
  pepper: string,
): string | null {
  if (!ref.startsWith(PREFIX)) return null;
  const rest = ref.slice(PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const body = rest.slice(0, dot);
  let id: string;
  try {
    id = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!id || !id.startsWith("int_")) return null;
  // Recomputing the whole reference and comparing it in constant time also
  // covers the encoding: a body that decodes to the right id but was written
  // differently produces different bytes and is refused, so one interaction
  // has exactly one reference and a cache or an audit trail cannot be split
  // across spellings of it.
  const expected = interactionRef(id, pepper);
  const a = Buffer.from(ref, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return id;
}

/**
 * The digest of a binding message.
 *
 * A receipt needs to prove which words were on the screen without storing the
 * words: binding messages quote user-supplied text — a payee name, a repo
 * path — and an audit store is the wrong place for attacker-authored strings.
 */
export function bindingMessageDigest(message: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update(`opensesame:binding-message:v1\0${message}`)
    .digest("hex");
}
