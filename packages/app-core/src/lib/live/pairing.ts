/**
 * The two pairing codes of a live session (ADR 0150 §3): how two browsers
 * meet with no server between them.
 *
 * 1. The joiner's page dials over the session's transport (`p2p.ts`) and
 *    seals the offer, with the person's name and note, into a **request
 *    code** only the owner can read. The person sends it to the owner however they already talk, or a
 *    carrier the owner named passes it on (`rendezvous.ts`).
 * 2. The owner's page opens it. One the link secret does not open was never
 *    a request (a stranger on a carrier); one that opens but whose inner seal
 *    does not — a wrong code in an invite session — is a miss. The owner lets
 *    the person in (an open session does at once), and the owner's page
 *    answers the offer and seals the answer into a **reply code** only that
 *    joiner can read and only the owner could have made.
 * 3. The joiner's page opens the reply, checks that it answers its own
 *    request, and the browsers connect.
 *
 * The owner's address is only ever in a reply, sealed to the one joiner the
 * owner let in, so nobody else learns it — not another joiner, and not
 * anyone watching a carrier.
 */

import type { LiveLink } from "./link.js";
import {
  type HandshakeReader,
  type JoinReply,
  type JoinRequest,
  readJoinReply,
  readJoinRequest,
} from "./messages.js";
import { type Keypair, type SealContext, seal, unseal } from "./seal.js";

export const REQUEST_PREFIX = "osl-request.";
export const REPLY_PREFIX = "osl-reply.";
/** Far more than any offer with host candidates needs. */
const CODE_MAX = 128 * 1024;

function context(
  link: LiveLink,
  code: string | null,
  purpose: SealContext["purpose"],
  bound: readonly string[],
  shared: Uint8Array<ArrayBuffer> | null = null,
): SealContext {
  return {
    secret: link.secret,
    code,
    purpose,
    bound: [link.owner, ...bound],
    shared,
  };
}

/** A raw P-256 public key, base64url. */
const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/;

/** iv ‖ ciphertext ‖ tag, base64url: at least 12 + 1 + 16 bytes. */
const SEALED = /^[A-Za-z0-9_-]{39,}$/;

/** Strip what a chat app adds around a pasted code: whitespace, quotes. */
function bare(text: string, prefix: string): string | null {
  const trimmed = text.replace(/\s+/g, "").replace(/^["'`]+|["'`]+$/g, "");
  if (trimmed.length > CODE_MAX || !trimmed.startsWith(prefix)) return null;
  return trimmed.slice(prefix.length);
}

/**
 * A request code: the request sealed to the owner under the secret it and
 * `joiner` share, inside a seal keyed by the link secret alone.
 */
export async function makeRequestCode(
  link: LiveLink,
  code: string | null,
  joiner: Keypair,
  request: JoinRequest,
): Promise<string> {
  const shared = await joiner.shared(link.owner);
  if (!shared) throw new Error("bad_owner_key");
  const inner = await seal(
    context(link, code, "request", [joiner.pub], shared),
    JSON.stringify(request),
  );
  const outer = await seal(
    context(link, null, "request-outer", []),
    `${joiner.pub}.${inner}`,
  );
  return `${REQUEST_PREFIX}${outer}`;
}

export type OpenedRequest =
  | Readonly<{ kind: "not-a-request" }>
  | Readonly<{ kind: "not-this-session" }>
  | Readonly<{ kind: "request"; request: JoinRequest; joiner: string }>;

/**
 * A request code: not one at all (nor from anyone holding the link), one
 * from a link holder that this session's code does not open (a miss), or a
 * request and the joiner key its reply is sealed to. An offer the session's
 * transport cannot take (`readsOffer`) is not a request.
 */
export async function openRequestCode(
  link: LiveLink,
  code: string | null,
  owner: Keypair,
  text: string,
  readsOffer: HandshakeReader,
): Promise<OpenedRequest> {
  const body = bare(text, REQUEST_PREFIX);
  if (!body || !SEALED.test(body)) return { kind: "not-a-request" };
  const envelope = await unseal(context(link, null, "request-outer", []), body);
  // Only a link holder can seal the outer layer; anything else is noise.
  if (envelope === null) return { kind: "not-a-request" };
  const [joiner, inner, ...rest] = envelope.split(".");
  if (!joiner || !PUBLIC_KEY.test(joiner) || !inner || rest.length > 0)
    return { kind: "not-a-request" };
  const shared = await owner.shared(joiner);
  if (!shared) return { kind: "not-a-request" };
  const plain = await unseal(
    context(link, code, "request", [joiner], shared),
    inner,
  );
  if (plain === null) return { kind: "not-this-session" };
  const request = readJoinRequest(plain, readsOffer);
  return request
    ? { kind: "request", request, joiner }
    : { kind: "not-a-request" };
}

/** A reply code, sealed to the joiner key the request carried. */
export async function makeReplyCode(
  link: LiveLink,
  code: string | null,
  owner: Keypair,
  joiner: string,
  reply: JoinReply,
): Promise<string> {
  const shared = await owner.shared(joiner);
  if (!shared) throw new Error("bad_joiner_key");
  const sealed = await seal(
    context(link, code, "reply", [joiner, reply.id], shared),
    JSON.stringify(reply),
  );
  return `${REPLY_PREFIX}${sealed}`;
}

/**
 * A reply code, if it opens under the secret this joiner shares with the
 * owner — so the owner made it — answers request `id`, and carries an answer
 * the session's transport can take (`readsAnswer`); else null.
 */
export async function openReplyCode(
  link: LiveLink,
  code: string | null,
  joiner: Keypair,
  id: string,
  text: string,
  readsAnswer: HandshakeReader,
): Promise<JoinReply | null> {
  const body = bare(text, REPLY_PREFIX);
  if (!body || !SEALED.test(body)) return null;
  const shared = await joiner.shared(link.owner);
  if (!shared) return null;
  const plain = await unseal(
    context(link, code, "reply", [joiner.pub, id], shared),
    body,
  );
  const reply = plain === null ? null : readJoinReply(plain, readsAnswer);
  return reply?.id === id ? reply : null;
}
