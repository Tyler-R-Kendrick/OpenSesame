/**
 * The two pairing codes of a live session (ADR 0148 §3): how two browsers
 * meet with no server between them.
 *
 * 1. The joiner's page makes its WebRTC offer and seals it, with the
 *    person's name and note, into a **request code**, which the person sends
 *    the owner however they already talk.
 * 2. The owner pastes it. Only a code sealed with the link secret — and, in
 *    an invite session, the code — opens; the owner lets the person in (an
 *    open session does at once), and the owner's page answers the offer and
 *    seals the answer into a **reply code**, signed with the owner key.
 * 3. The joiner pastes the reply; its page checks the owner's signature and
 *    that the reply answers its own request, and the browsers connect.
 *
 * The owner's address is only ever in a reply, so nobody the owner did not
 * let in learns it. No ICE server is configured by default: the browsers
 * reach each other directly, or not at all.
 */

import type { LiveLink } from "./link.js";
import {
  type JoinReply,
  type JoinRequest,
  readJoinReply,
  readJoinRequest,
} from "./messages.js";
import {
  type OwnerKey,
  type SealContext,
  seal,
  unseal,
  verifyOwner,
} from "./seal.js";

export const REQUEST_PREFIX = "osl-request.";
export const REPLY_PREFIX = "osl-reply.";
/** Far more than any offer with host candidates needs. */
const CODE_MAX = 128 * 1024;

function context(
  link: LiveLink,
  code: string | null,
  purpose: SealContext["purpose"],
  bound: readonly string[],
): SealContext {
  return { secret: link.secret, code, purpose, bound: [link.owner, ...bound] };
}

/** iv ‖ ciphertext ‖ tag, base64url: at least 12 + 1 + 16 bytes. */
const SEALED = /^[A-Za-z0-9_-]{39,}$/;

/** Strip what a chat app adds around a pasted code: whitespace, quotes. */
function bare(text: string, prefix: string): string | null {
  const trimmed = text.replace(/\s+/g, "").replace(/^["'`]+|["'`]+$/g, "");
  if (trimmed.length > CODE_MAX || !trimmed.startsWith(prefix)) return null;
  return trimmed.slice(prefix.length);
}

export async function makeRequestCode(
  link: LiveLink,
  code: string | null,
  request: JoinRequest,
): Promise<string> {
  const sealed = await seal(
    context(link, code, "request", []),
    JSON.stringify(request),
  );
  return `${REQUEST_PREFIX}${sealed}`;
}

export type OpenedRequest =
  | Readonly<{ kind: "not-a-request" }>
  | Readonly<{ kind: "not-this-session" }>
  | Readonly<{ kind: "request"; request: JoinRequest }>;

/**
 * A pasted request code: not one at all, one this session's link and code
 * do not open (a wrong code counts toward ending the session), or a request.
 */
export async function openRequestCode(
  link: LiveLink,
  code: string | null,
  text: string,
): Promise<OpenedRequest> {
  const body = bare(text, REQUEST_PREFIX);
  // Only a well-formed seal can be a miss; anything else was never a code.
  if (!body || !SEALED.test(body)) return { kind: "not-a-request" };
  const plain = await unseal(context(link, code, "request", []), body);
  if (plain === null) return { kind: "not-this-session" };
  const request = readJoinRequest(plain);
  return request ? { kind: "request", request } : { kind: "not-a-request" };
}

export async function makeReplyCode(
  link: LiveLink,
  code: string | null,
  owner: OwnerKey,
  reply: JoinReply,
): Promise<string> {
  const sealed = await seal(
    context(link, code, "reply", [reply.id]),
    JSON.stringify(reply),
  );
  return `${REPLY_PREFIX}${sealed}.${await owner.sign(sealed)}`;
}

/**
 * A pasted reply code, if the owner signed it, it opens with this link and
 * code, and it answers request `id`; else null.
 */
export async function openReplyCode(
  link: LiveLink,
  code: string | null,
  id: string,
  text: string,
): Promise<JoinReply | null> {
  const body = bare(text, REPLY_PREFIX);
  if (!body) return null;
  const [sealed, signature, ...rest] = body.split(".");
  if (!sealed || !signature || rest.length > 0) return null;
  if (!(await verifyOwner(link.owner, sealed, signature))) return null;
  const plain = await unseal(context(link, code, "reply", [id]), sealed);
  const reply = plain === null ? null : readJoinReply(plain);
  return reply?.id === id ? reply : null;
}
