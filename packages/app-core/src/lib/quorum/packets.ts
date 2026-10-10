/**
 * Packets: how the documents of a circle travel between people (ADR 0186 §10).
 *
 * Nothing here goes to a server. An invite, an enrollment, a share, an approval
 * is a plain JSON document (every one is already strict-parsed where it is
 * used), and a person carries it to the next person over whatever road they
 * already trust: a message, a QR code, a file, a live session. A packet is
 * that document as one line of text that survives being pasted into a chat,
 * wrapped by a mail client, or read aloud:
 *
 *   osq1.<kind>.<base64url of the JSON>.<check>
 *
 * - The **kind** is stated so the screen knows what it was handed before it
 *   reads it, and it is checked: a packet that says `invite` and holds an
 *   enrollment is refused, not coerced.
 * - The **check** is the first six hex characters of a SHA-256 over the kind
 *   and body. It catches a truncated or mangled paste with a message a person
 *   can act on ("this was cut off"). It is not a MAC and proves nothing about
 *   who wrote the packet: every packet is verified by its own signatures and
 *   digests (a policy by the owner key, an approval by the guardian's key),
 *   never by having arrived.
 * - Whitespace anywhere in the pasted text is ignored.
 * - A packet is capped, and a document is parsed by the same strict schema
 *   the protocol uses, so a hostile paste cannot bring an unknown field, a
 *   prototype key or an oversized value past this door.
 *
 * The recovery bundle is not a packet: it carries the protected payload and
 * can be large, so it travels as a file.
 */

import { sha256 } from "@noble/hashes/sha2";
import { z } from "zod";
import { fromB64url, toB64url, toHex, utf8Bytes, utf8Text } from "./bytes.js";
import { ShareDeliverySchema } from "./circle.js";
import { EnrollmentSchema, InviteSchema } from "./enroll.js";
import { CustodyReceiptSchema } from "./guardian.js";
import {
  ApprovalSchema,
  CancellationSchema,
  QuorumRequestSchema,
  ReleaseSchema,
  SignedPolicySchema,
} from "./types.js";

const PREFIX = "osq1";
/** Decoded JSON, in bytes. A signed policy of 32 guardians fits well inside. */
export const MAX_PACKET_BYTES = 128 * 1024;
/** The most approvals one packet can carry: one per guardian. */
const MAX_APPROVALS = 32;

export class PacketError extends Error {
  constructor(
    readonly code: "format" | "checksum" | "size" | "kind" | "document",
    message: string,
  ) {
    super(message);
    this.name = "PacketError";
  }
}

function member<K extends string, S extends z.ZodType>(kind: K, value: S) {
  return z.object({ kind: z.literal(kind), value }).strict();
}

/**
 * What the owner hands each guardian: the signed policy and, in a circle that
 * holds shares, that guardian's sealed share. One packet, so a guardian is never
 * left holding a share without the policy that explains and commits to it.
 * An action-only circle has no share, so the delivery is `null`.
 */
export const WelcomeSchema = z
  .object({
    signedPolicy: SignedPolicySchema,
    delivery: ShareDeliverySchema.nullable(),
  })
  .strict();
export type Welcome = z.infer<typeof WelcomeSchema>;

/** Every kind a packet can be, with the schema of the document it holds. */
export const PacketSchema = z.discriminatedUnion("kind", [
  member("invite", InviteSchema),
  member("enrollment", EnrollmentSchema),
  member("policy", SignedPolicySchema),
  member("welcome", WelcomeSchema),
  member("delivery", ShareDeliverySchema),
  member("receipt", CustodyReceiptSchema),
  member("request", QuorumRequestSchema),
  member("approval", ApprovalSchema),
  member("approvals", z.array(ApprovalSchema).min(1).max(MAX_APPROVALS)),
  member("release", ReleaseSchema),
  member("cancellation", CancellationSchema),
]);
export type Packet = z.infer<typeof PacketSchema>;
export type PacketKind = Packet["kind"];

/** Every kind, in the order a ceremony meets them. A test holds it equal to the schema's. */
export const PACKET_KINDS = [
  "invite",
  "enrollment",
  "policy",
  "welcome",
  "delivery",
  "receipt",
  "request",
  "approval",
  "approvals",
  "release",
  "cancellation",
] as const satisfies readonly Packet["kind"][];

function check(kind: string, body: string): string {
  return toHex(sha256(utf8Bytes(`${PREFIX}.${kind}.${body}`))).slice(0, 6);
}

/** One line of text for a document. The document is validated first. */
export function encodePacket(packet: Packet): string {
  const valid = PacketSchema.parse(packet);
  const json = JSON.stringify(valid.value);
  const bytes = utf8Bytes(json);
  if (bytes.length > MAX_PACKET_BYTES) {
    throw new PacketError("size", "this is too large to pass as a packet");
  }
  const body = toB64url(bytes);
  return `${PREFIX}.${valid.kind}.${body}.${check(valid.kind, body)}`;
}

const PACKET_PATTERN = /^osq1\.([a-z]+)\.([A-Za-z0-9_-]+)\.([0-9a-f]{6})$/;

/**
 * The document a packet holds, parsed. Throws a `PacketError` whose `code`
 * says what to tell the person: not a packet at all, cut off, too large, a
 * kind this screen does not take, or a document that is not what it claims.
 */
export function decodePacket(text: string): Packet {
  const compact = text.replace(/\s+/g, "");
  const match = PACKET_PATTERN.exec(compact);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new PacketError("format", "this is not a packet");
  }
  const [, kind, body, sum] = match;
  if (check(kind, body) !== sum) {
    throw new PacketError(
      "checksum",
      "this packet was cut off or changed on the way",
    );
  }
  if (!PACKET_KINDS.some((known) => known === kind)) {
    throw new PacketError("kind", `${kind} is not a kind of packet`);
  }
  // Four base64 characters are three bytes: refuse before decoding.
  if ((body.length * 3) / 4 > MAX_PACKET_BYTES) {
    throw new PacketError("size", "this packet is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(utf8Text(fromB64url(body)));
  } catch {
    throw new PacketError("format", "this packet does not hold a document");
  }
  const parsed = PacketSchema.safeParse({ kind, value });
  if (!parsed.success) {
    throw new PacketError("document", `this is not a valid ${kind}`);
  }
  return parsed.data;
}

/** The kind a pasted packet says it is, without reading the document. `null` when it is not one. */
export function packetKind(text: string): PacketKind | null {
  const match = PACKET_PATTERN.exec(text.replace(/\s+/g, ""));
  const kind = match?.[1];
  return PACKET_KINDS.find((known) => known === kind) ?? null;
}

function isKind<K extends PacketKind>(
  packet: Packet,
  kind: K,
): packet is Extract<Packet, { kind: K }> {
  return packet.kind === kind;
}

/**
 * A packet of exactly the kind a screen asks for, whole: read `.value` for the
 * document. A screen that wants an enrollment is handed one or a
 * `PacketError`, never an invite that happens to parse.
 */
export function expectPacket<K extends PacketKind>(
  text: string,
  kind: K,
): Extract<Packet, { kind: K }> {
  const packet = decodePacket(text);
  if (!isKind(packet, kind)) {
    throw new PacketError(
      "kind",
      `this is ${article(packet.kind)}, not ${article(kind)}`,
    );
  }
  return packet;
}

function article(kind: string): string {
  return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}
