import type {
  InteractionDetail,
  InteractionKind,
  InteractionStatus,
} from "@opensesame/os-domain";

/**
 * What an interaction says, as plain text (ADR 0086, ADR 0061).
 *
 * One renderer for every screen an approval can land on: a phone PWA, the
 * Pages vault, a terminal, a wallet pass, an MCP tool result. They cannot
 * share components, but they must not disagree about the words — two devices
 * showing different descriptions of the same request is the exact failure
 * CIBA's binding message exists to prevent.
 *
 * **Output is text, never markup.** The return value is plain strings and the
 * caller renders them as text nodes. This module does not escape HTML, because
 * escaping is a function of the destination and this module does not know the
 * destination; instead it *removes* the characters that could open a tag, so
 * the result cannot become markup even in a caller that concatenates it into
 * `innerHTML` by mistake.
 *
 * **Everything quoted here is attacker-authored.** A payee name, a resource
 * name, a binding message — all of them are chosen by whoever is asking for the
 * approval, and the approval screen is precisely where a lie is most valuable.
 * The sanitizer below is the only thing standing between "Pay ACME Ltd" and a
 * string that renders as something else entirely.
 *
 * The voice is ADR 0061's: terse rows, no prose, no captions explaining what a
 * ceremony is. The screen asks a question; it does not teach.
 */

/** The rendered ceremony: a heading, then one fact per line. */
export interface RenderedInteractionSummary {
  title: string;
  lines: string[];
}

/**
 * Characters removed from every quoted value.
 *
 * - **C0 and C1 controls** (`U+0000`–`U+001F`, `U+007F`–`U+009F`): newline and
 *   carriage return let a value forge extra rows in a terminal, a log line, or
 *   a wallet pass field; `U+0000` truncates the string in anything that
 *   eventually reaches C.
 * - **Bidirectional overrides, embeddings and isolates** (`U+202A`–`U+202E`,
 *   `U+2066`–`U+2069`) and the directional marks `U+200E`, `U+200F`, `U+061C`.
 *   These are the spoofing vector, and the reason this function exists. Right-
 *   to-left override (`U+202E`) reverses the display order of everything after
 *   it, so a payee stored as `ACME` + `U+202E` + `dtl tnuocca-daf` is *read* by
 *   the human as a different company than the one the bytes name — the string
 *   that gets approved and the glyphs that got looked at are not the same
 *   string. An unbalanced override also leaks into the following line and
 *   re-orders the rest of the screen, which is why these are stripped outright
 *   rather than balanced with a closing `U+202C`.
 * - **Zero-width characters** (`U+200B`–`U+200D`, `U+FEFF`): invisible padding
 *   that makes two visually identical names distinct records, or pushes a
 *   distinguishing suffix past a truncation point.
 * - **`<` and `>`**: removed so no output string can be read as a tag by any
 *   renderer, however careless.
 */
const UNSAFE_DISPLAY =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is this expression's entire purpose.
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF<>]/g;

/**
 * How much of a requester-supplied string reaches a screen.
 *
 * Short on purpose. A long value is not more informative — it is a way to push
 * the part that matters off a phone screen, or to bury a contradiction below
 * the fold.
 */
const MAX_QUOTED_LENGTH = 96;

/**
 * Make a requester-supplied string safe to display.
 *
 * Order matters: strip first, then collapse whitespace, then truncate. The
 * other order could cut in the middle of a sequence and leave a lone override
 * behind, or spend the whole budget on invisible characters. The ellipsis is
 * appended after the cut so a truncated value never looks complete — a payee
 * that quietly loses its suffix is a spoof by omission.
 */
function quote(value: string): string {
  const stripped = value
    .replace(UNSAFE_DISPLAY, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length === 0) return "";
  if (stripped.length <= MAX_QUOTED_LENGTH) return stripped;
  return `${stripped.slice(0, MAX_QUOTED_LENGTH)}…`;
}

/**
 * The question, by kind.
 *
 * Each is a demand, not a description: `device_authorization` and `claim` must
 * never read alike, because approving a device says a session may exist while
 * claiming says a principal now owns something (ADR 0009). The fallback covers
 * a kind a deployed client has not heard of — an unknown ceremony still gets a
 * heading that reads as a decision rather than as a blank.
 */
const TITLES = {
  device_authorization: "Approve this device",
  pairing: "Pair this device",
  claim: "Accept this claim",
  grant_claim: "Accept this grant",
  authorization_request: "Approve this request",
  transaction_authorization: "Authorize this transaction",
} as const satisfies Record<InteractionKind, string>;

const UNKNOWN_TITLE = "Approve this request";

/**
 * Status lines, for the states where the answer is already settled.
 *
 * Total over `InteractionStatus` rather than partial, so adding a state to the
 * domain union forces a decision here instead of silently rendering nothing.
 * The three unsettled states are spelled out with no line on purpose: the
 * screen *is* the question, and captioning it "this is pending" is the
 * explanatory prose ADR 0061 removed. A status this build has never heard of
 * misses the table entirely and, like the unsettled three, adds no line.
 */
const STATUS_LINES = {
  pending: undefined,
  presented: undefined,
  awaiting_approval: undefined,
  approved: "Already approved",
  denied: "Already denied",
  consumed: "Already used",
  expired: "Expired",
  revoked: "Withdrawn",
} as const satisfies Record<InteractionStatus, string | undefined>;

/**
 * Render an interaction for a human.
 *
 * Ordering is fixed and deliberate: the binding message first, because it is
 * the one string both devices show and the one the user is meant to compare;
 * then who is asking and what is being touched; then the deadline; then, only
 * when it is already settled, the outcome.
 *
 * Times are emitted as ISO 8601 UTC rather than a friendly local string. This
 * package has no locale, no timezone and no clock, and inventing any of the
 * three would mean two surfaces disagreeing about when a request lapses. A
 * surface with a real user reformats it.
 */
export function renderInteractionSummary(
  detail: InteractionDetail,
): RenderedInteractionSummary {
  const title = TITLES[detail.kind] ?? UNKNOWN_TITLE;
  const lines: string[] = [];

  const bindingMessage =
    detail.bindingMessage === undefined ? "" : quote(detail.bindingMessage);
  if (bindingMessage.length > 0) lines.push(bindingMessage);

  const requester =
    detail.requesterRef === undefined ? "" : quote(detail.requesterRef);
  if (requester.length > 0) lines.push(`From ${requester}`);

  const resource =
    detail.resourceRef === undefined ? "" : quote(detail.resourceRef);
  if (resource.length > 0) lines.push(`Resource ${resource}`);

  lines.push(`Expires ${detail.expiresAt.toISOString()}`);

  const status = STATUS_LINES[detail.status];
  if (status !== undefined) lines.push(status);

  return { title, lines };
}
