/**
 * What a notification is allowed to say, and how it says it safely.
 *
 * Two separate problems, both of which end badly if solved by convention:
 *
 * 1. **Disclosure.** A lock screen, a chat archive, an SMS on a carrier's
 *    infrastructure and a compliance export are all "the notification". The
 *    router has already reduced each step to a `NotificationConfidentiality`
 *    ceiling; this module is where that ceiling is actually enforced, by
 *    building the body from a different set of fields per level rather than
 *    by building one body and hoping to redact it afterwards.
 * 2. **Injection.** `bindingMessage`, `actionLabel` and `requesterLabel` are
 *    written by whoever asked for the authorization. That text lands inside
 *    Slack mrkdwn, Telegram HTML, a Teams Markdown card and a WeChat XML
 *    document, and in front of a person who is about to decide something. So
 *    it is neutralized once, structurally, before any provider sees it.
 *
 * The comparison code is absent from both halves and absent from
 * `RenderInput` — see the note there. Nothing here can render it because
 * nothing here can be handed it.
 */

import {
  type JsonObject,
  type NotificationConfidentiality,
  leastConfidentiality,
  readString,
} from "@opensesame/os-domain";

import type { RenderInput, RenderedMessage } from "./contract.js";

/* ------------------------------------------------------------------ *
 * Sanitizing requester-supplied text
 * ------------------------------------------------------------------ */

/**
 * The markup a provider will interpret in the text we hand it.
 *
 * Escaping is per-dialect because the dialects disagree about what is
 * dangerous, and a single "escape everything" pass produces either mangled
 * text on one provider or live markup on another.
 */
export type MarkupDialect =
  | "plain"
  | "slack_mrkdwn"
  | "telegram_html"
  | "teams_markdown"
  | "xml_text";

export interface SanitizeOptions {
  dialect: MarkupDialect;
  maxLength: number;
}

/**
 * Bidirectional formatting controls — the Trojan Source family.
 *
 * They do not change the string; they change the order a human reads it in,
 * so a binding message can be authored to render as a sentence it does not
 * contain. An approver deciding on the strength of text that lies about its
 * own order has not been asked the question we think we asked. They are
 * removed rather than escaped: no legitimate binding message needs to
 * reorder the sentence around it.
 *
 * U+202A-U+202E are the embedding and override set, U+2066-U+2069 the
 * isolates, and U+200E/U+200F/U+061C the invisible directional marks.
 */
function isBidiControl(codePoint: number): boolean {
  return (
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x061c
  );
}

/**
 * Zero-width and invisible characters.
 *
 * They let one string display as another without needing a lookalike
 * alphabet, and they let an exact-match check miss text a person reads
 * perfectly well.
 */
function isInvisible(codePoint: number): boolean {
  return (
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    codePoint === 0x2060 ||
    codePoint === 0xfeff ||
    codePoint === 0x180e ||
    codePoint === 0x00ad
  );
}

/**
 * C0 and C1 control characters.
 *
 * Past the terminal-escape problem, a lone CR or LF inside a value is how
 * one text field becomes two header lines or two log records. The
 * whitespace-ish ones become a space so words do not run together; the rest
 * are dropped outright.
 */
function isControlWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x0009 && codePoint <= 0x000d) ||
    codePoint === 0x0085 ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

function isOtherControl(codePoint: number): boolean {
  return (
    codePoint <= 0x0008 ||
    (codePoint >= 0x000e && codePoint <= 0x001f) ||
    (codePoint >= 0x007f && codePoint <= 0x009f)
  );
}

/**
 * The removal pass, written as a code-point walk rather than a character
 * class.
 *
 * `for…of` over a string iterates code points, so an astral character is one
 * step and cannot be split into lone surrogates that a later escape would
 * treat as ordinary text. A regex character class over the same ranges reads
 * as if it did the same thing and does not.
 */
function stripHostileCharacters(text: string): string {
  let out = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      isBidiControl(codePoint) ||
      isInvisible(codePoint) ||
      isOtherControl(codePoint)
    ) {
      continue;
    }
    out += isControlWhitespace(codePoint) ? " " : character;
  }
  return out;
}

/** Runs of whitespace collapse, so a removal cannot be spotted as a gap. */
const WHITESPACE_RUN = /\s{2,}/gu;

/**
 * Neutralize requester-supplied text for one provider.
 *
 * The order is load-bearing:
 *
 * - Normalize first (NFC), so a decomposed sequence cannot slip past a
 *   removal that only knows the composed form.
 * - Strip the invisible and reordering characters, then the controls.
 * - Truncate *before* escaping. Truncating afterwards can cut an escape in
 *   half and hand the provider a fragment such as `&l`, which more than one
 *   renderer helpfully repairs back into live markup.
 * - Escape last, once, for the one dialect this text is going to.
 */
export function sanitizeUntrustedText(
  text: string,
  options: SanitizeOptions,
): string {
  const stripped = stripHostileCharacters(text.normalize("NFC"))
    .replace(WHITESPACE_RUN, " ")
    .trim();
  const capped =
    stripped.length > options.maxLength
      ? `${stripped.slice(0, Math.max(0, options.maxLength - 1))}…`
      : stripped;
  return escapeForDialect(capped, options.dialect);
}

/**
 * Slack's own rule, and only it: `&` first, then `<` and `>`. Slack
 * documents those three as the characters that must be encoded in message
 * text. Escaping more mangles ordinary punctuation; escaping `&` last would
 * double-encode the entities the earlier passes just introduced.
 */
function escapeAmpersandAngles(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/**
 * Teams renders card text as Markdown and lets some HTML through, so both
 * vocabularies are neutralized: the ampersand and angle brackets for the
 * HTML half, and a backslash before the Markdown metacharacters that can
 * otherwise forge a link, a heading, or emphasis around the real text.
 */
function escapeTeamsMarkdown(text: string): string {
  return escapeAmpersandAngles(text).replace(
    /[\\`*_[\]()~#+\-=|{}!]/gu,
    (ch) => `\\${ch}`,
  );
}

/**
 * WeChat message bodies are XML and ours put text inside CDATA. Escaping the
 * XML metacharacters covers the plain case; breaking `]]>` covers the CDATA
 * one, since that sequence is the only way out of a CDATA section and
 * outside it the text is markup again.
 */
function escapeXmlText(text: string): string {
  return escapeAmpersandAngles(text).replace(/\]\]>/gu, "]]&gt;");
}

function escapeForDialect(text: string, dialect: MarkupDialect): string {
  if (dialect === "slack_mrkdwn") return escapeAmpersandAngles(text);
  // Telegram's HTML parse mode is real HTML parsing over a tag allowlist, so
  // an unescaped `<b>` is formatting and an unescaped `<a href>` is a link
  // the approver may click. Same three characters, same reason.
  if (dialect === "telegram_html") return escapeAmpersandAngles(text);
  if (dialect === "teams_markdown") return escapeTeamsMarkdown(text);
  if (dialect === "xml_text") return escapeXmlText(text);
  return text;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** A binding message is a sentence, not a document. */
export const MAX_BINDING_MESSAGE_CHARS = 180;
export const MAX_ACTION_LABEL_CHARS = 64;
export const MAX_REQUESTER_LABEL_CHARS = 64;
/** An unbounded "reference" is a way to write arbitrary length downstream. */
export const MAX_RENDEZVOUS_REF_CHARS = 64;

export interface RenderOptions {
  dialect: MarkupDialect;
  /** The channel's own ceiling; the effective level is the lower of the two. */
  channelCeiling: NotificationConfidentiality;
}

const TITLE_BY_CLASS = {
  authorization_request: "Authorization requested",
  authorization_decision: "Authorization decided",
  security_event: "Security event",
} as const;

/**
 * Build the body for one channel at one confidentiality.
 *
 * The effective level is the *lower* of what the caller asked for and what
 * the channel can hold, recomputed here rather than trusted from the input,
 * so a caller assembling a `RenderInput` by hand cannot talk an SMS into
 * carrying a `full` body.
 */
export function renderNotification(
  input: RenderInput,
  options: RenderOptions,
): RenderedMessage {
  const level = leastConfidentiality(
    input.confidentiality,
    options.channelCeiling,
  );
  const lines: string[] = [minimalSentence(input)];

  if (level !== "minimal") {
    const action = cleanField(
      input.actionLabel,
      MAX_ACTION_LABEL_CHARS,
      options,
    );
    if (action) lines.push(`Action: ${action}`);
    const message = cleanField(
      input.bindingMessage,
      MAX_BINDING_MESSAGE_CHARS,
      options,
    );
    if (message) lines.push(`Message: ${message}`);
  }

  if (level === "full") {
    const requester = cleanField(
      input.requesterLabel,
      MAX_REQUESTER_LABEL_CHARS,
      options,
    );
    if (requester) lines.push(`Requested by: ${requester}`);
    const details = summarizeAuthorizationDetails(input, options);
    if (details) lines.push(`Details: ${details}`);
  }

  lines.push("Open OpenSesame to review and decide.");

  const base: RenderedMessage = {
    kind: input.kind,
    confidentiality: level,
    title: TITLE_BY_CLASS[input.notificationClass],
    body: lines.join("\n"),
  };
  const withUrl = input.rendezvousUrl
    ? { ...base, rendezvousUrl: input.rendezvousUrl }
    : base;
  return input.decisionTokens
    ? { ...withUrl, decisionTokens: input.decisionTokens }
    : withUrl;
}

/**
 * The whole of a `minimal` body: that something was asked, and the opaque
 * handle for finding it.
 *
 * No binding message — it is requester-controlled text, so rendering it is
 * handing the requester a pen on the approver's lock screen. No principal or
 * requester identifiers — those name a person and a relationship to whoever
 * can see the screen. No authorization details — "delete production
 * database" on a notification shade discloses what the organization is doing
 * to anyone standing nearby.
 */
function minimalSentence(input: RenderInput): string {
  const ref = input.rendezvousRef.slice(0, MAX_RENDEZVOUS_REF_CHARS);
  return `OpenSesame is holding an authorization request. Reference ${ref}.`;
}

function cleanField(
  value: string | undefined,
  maxLength: number,
  options: RenderOptions,
): string | undefined {
  if (!value) return undefined;
  const clean = sanitizeUntrustedText(value, {
    dialect: options.dialect,
    maxLength,
  });
  return clean.length > 0 ? clean : undefined;
}

/**
 * `full` still does not paste the raw RFC 9396 array into a message.
 *
 * Only the structural `type` keys are named. An `authorization_details`
 * entry routinely carries account numbers, resource paths and amounts, and
 * this text is going somewhere durable. The in-app ceremony shows the array;
 * the notification says how many there are and what shape they have.
 */
function summarizeAuthorizationDetails(
  input: RenderInput,
  options: RenderOptions,
): string | undefined {
  const details: readonly JsonObject[] = input.authorizationDetails ?? [];
  if (details.length === 0) return undefined;
  const types: string[] = [];
  for (const entry of details) {
    const label = readString(entry.type);
    if (label && !types.includes(label)) types.push(label);
  }
  if (types.length === 0) return `${details.length} entries`;
  const joined = types
    .slice(0, 4)
    .map((type) =>
      sanitizeUntrustedText(type, { dialect: options.dialect, maxLength: 48 }),
    )
    .join(", ");
  return `${details.length} entries (${joined})`;
}
