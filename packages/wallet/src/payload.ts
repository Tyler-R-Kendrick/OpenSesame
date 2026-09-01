/**
 * The last gate a wallet pass passes through before it leaves this process.
 *
 * A pass is not like other outbound data. It is copied to a vendor's cloud,
 * replicated to every device on the account, cached indefinitely, rendered on
 * a lock screen, and shown to whoever is nearby. There is no recall. So the
 * question this module answers is not "is this payload well-formed" but "if
 * this exact JSON were published on a billboard tomorrow, would anything be
 * lost?" — and it answers it by refusing anything it cannot vouch for.
 *
 * Four properties make it worth having rather than trusting the callers:
 *
 * 1. **It runs on every pass**, not only in tests. A check that only exists in
 *    a test suite protects the code paths somebody remembered to test; this
 *    one sits in `issuePass` and in every REST mutation, so a future field
 *    added to the Google object by a well-meaning change is inspected without
 *    anybody deciding to inspect it.
 * 2. **It is deny-first.** Every rule below refuses a shape that *might* be
 *    credential material. Legitimate passes carry titles, labels, and one
 *    opaque URL; none of them look like a bearer, so the false-positive cost
 *    is near zero and the false-negative cost is permanent.
 * 3. **It inspects the bytes it is about to emit, not the object it was
 *    handed.** The content walk runs over `JSON.parse(JSON.stringify(payload))`.
 *    That detour is the entire point. A `toJSON` method, an accessor, or a
 *    `Proxy` can show one thing to a walker reading `Object.entries` and
 *    something else to the serializer that follows — and it is the serializer's
 *    answer that gets signed. An earlier version of this file walked the live
 *    graph, so `{ note: { toJSON: () => "<a claim token>" } }` was inspected as
 *    an object holding a function (no entries, nothing to see) and then
 *    serialized as the token. Scanning the serializer's own output makes "what
 *    was checked" and "what was emitted" the same bytes by construction, and
 *    `assertJsonData` refuses the two constructs — `toJSON` and accessors —
 *    that could still make *this* serialization differ from the signer's.
 * 4. **It quotes no value, and only a name that still looks like a name.**
 *    `WalletPayloadRejected` carries the rule, a path, and a field name, and
 *    stops there. An exception that helpfully printed the token it found would
 *    put that token into a log, an error tracker, and probably a support
 *    ticket — the exact outcome the check exists to prevent. Field names are
 *    structure and an operator cannot act without them, but they are *also*
 *    caller-supplied: a Google display-row label becomes a field name here
 *    (see `google.ts`), and a label is free-form UI text that could hold a
 *    newline, a control character, or a misplaced secret. So every name and
 *    path segment in a message goes through `displayName`, which prints a
 *    name that still reads like one and elides anything that does not.
 *
 * The key deny-list is `FORBIDDEN_URL_PARAMS` from `@opensesame/os-domain`,
 * reused rather than re-declared. One list means a name added there because a
 * URL must never carry it is automatically a name a pass must never carry
 * either, which is the same statement said twice.
 */

import {
  type BoundaryValue,
  FORBIDDEN_URL_PARAMS,
  isBigint,
  isBoolean,
  isFunction,
  isJsonObject,
  isNumber,
  isString,
  isSymbol,
  isTypeofObject,
  isUndefined,
} from "@opensesame/os-domain";

/** Which rule refused the payload. Stable enough to branch on and to alert on. */
export type WalletPayloadRule =
  | "forbidden_key"
  | "forbidden_url_param"
  | "unsafe_url_scheme"
  | "bearer_shape"
  | "labelled_high_entropy"
  | "primary_account_number"
  | "card_verification_value"
  | "non_json_value"
  | "cyclic_payload";

/**
 * A pass payload that must not be serialized.
 *
 * The message names the rule and the path and deliberately omits the value.
 * `path` is a JSON-pointer-ish breadcrumb (`$.barcode.value`) so an operator
 * can find the offending field in their own source without the offending
 * content ever being written down. Every caller-derived fragment of both
 * arguments has already been through `displayName`, so neither the message nor
 * the `path` field can carry a newline into a log line.
 */
export class WalletPayloadRejected extends Error {
  readonly rule: WalletPayloadRule;
  readonly path: string;
  constructor(rule: WalletPayloadRule, path: string, detail: string) {
    super(`wallet payload rejected [${rule}] at ${path}: ${detail}`);
    this.name = "WalletPayloadRejected";
    this.rule = rule;
    this.path = path;
  }
}

/** What a printed field name is replaced by when it does not read as one. */
const ELIDED_NAME = "<elided>";

/** Long enough for `client_assertion_type`; short enough not to be a payload. */
const NAME_MAX_LENGTH = 40;

/**
 * Characters a field name may contain and still be printed verbatim.
 *
 * Deliberately excludes every C0 control character, so a newline in a display
 * row label cannot forge a second log line, and every quote and brace, so a
 * name cannot forge structure inside a JSON-formatted log record.
 */
const NAME_SAFE_CHARS = /^[A-Za-z0-9 ._:+-]+$/u;

/** Runs of name characters, for the "is this a word or a blob" test below. */
const NAME_WORDS = /[A-Za-z0-9]+/gu;

/**
 * A word long enough and mixed enough to be a secret rather than a name.
 *
 * Length alone does not separate the two: `client_assertion_type` is twenty-one
 * characters of perfectly ordinary field name. What separates them is that
 * names are made of words and secrets are not — a sixteen-character run that
 * mixes letters and digits with no separator is an encoding, not English. That
 * keeps `cardVerificationValue` (letters only) printable while eliding
 * `M2Y0YTk4YmMxZDdlNGYyMA` if somebody puts it where a name belongs.
 */
function looksOpaque(name: string): boolean {
  for (const word of name.match(NAME_WORDS) ?? []) {
    if (word.length < 16) continue;
    if (/[A-Za-z]/u.test(word) && /[0-9]/u.test(word)) return true;
  }
  return false;
}

/**
 * A field name as it may appear in an error message, a log, and a ticket.
 *
 * The caller owns this string — a `textModulesData` header is whatever text a
 * product surface put in a display row — so it is treated as content on its way
 * into a log rather than as a trusted identifier. A name that still reads as a
 * name is printed, because an operator cannot fix a rejection they cannot
 * locate; anything else is elided, because a message that leaked the secret it
 * refused would be a worse bug than the one it reported.
 */
function displayName(name: string): string {
  if (name.length === 0 || name.length > NAME_MAX_LENGTH) return ELIDED_NAME;
  if (!NAME_SAFE_CHARS.test(name)) return ELIDED_NAME;
  if (looksOpaque(name)) return ELIDED_NAME;
  return name;
}

/**
 * Collapse a field name to its comparable core.
 *
 * `access_token`, `accessToken`, `Access-Token`, and `ACCESS TOKEN` are the
 * same field wearing four hats, and a deny-list that only knew one spelling
 * would be trivially defeated by picking another. Stripping every separator
 * and case makes the four indistinguishable to the check.
 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/**
 * Split a field name into its words.
 *
 * Used for *labelling* rather than matching, and the distinction is what keeps
 * the check usable: `barcode` normalizes to `barcode`, which is not the
 * forbidden name `code`, but a naive substring test would have matched `code`
 * inside it and rejected every legitimate Google pass we ever build. Words,
 * not substrings.
 */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/** Exact field names that may never appear, in any spelling. */
const FORBIDDEN_KEY_NAMES: ReadonlySet<string> = new Set([
  ...FORBIDDEN_URL_PARAMS.map(normalizeName),
  // Card-verification aliases. `cvv` is already on the shared list; the
  // scheme-specific spellings are not, and a field named `cvc2` is no less a
  // card verification value than one named `cvv`.
  "cvc",
  "cvv2",
  "cvc2",
  "cardverificationvalue",
  "cardverificationcode",
  "cardsecuritycode",
  "securitycode",
]);

/** Field names whose presence alone means the payload touched card data. */
const CARD_VERIFICATION_NAMES: ReadonlySet<string> = new Set([
  "cvv",
  "cvc",
  "cvv2",
  "cvc2",
  "cardverificationvalue",
  "cardverificationcode",
  "cardsecuritycode",
  "securitycode",
]);

/**
 * Words too generic to mean "credential" on their own.
 *
 * Derived words like `id`, `card`, and `client` appear in `FORBIDDEN_URL_PARAMS`
 * only as one half of a compound (`id_token`, `card_number`, `client_secret`).
 * Promoting them to standalone labels would flag `classId` and `cardTitle`,
 * and a gate that fires on every legitimate pass is a gate somebody turns off.
 */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "id",
  "device",
  "client",
  "claim",
  "card",
  "number",
  "ref",
  "vp",
  "api",
]);

/**
 * Vocabulary that makes a field name a *label* for credential material.
 *
 * Derived from the shared deny-list rather than hand-written, so it tracks it.
 * A field whose name contains one of these words *and* whose value contains a
 * long opaque run is refused even though the name is not an exact match —
 * `userToken`, `sessionHint`, and `signingKeyMaterial` are all the deny-list
 * wearing a disguise.
 */
const CREDENTIAL_LABEL_WORDS: ReadonlySet<string> = new Set(
  FORBIDDEN_URL_PARAMS.flatMap(nameWords).filter(
    (word) => !GENERIC_WORDS.has(word),
  ),
);

/**
 * Schemes that must never appear in a pass.
 *
 * `linksModuleData` renders as a tappable link inside the wallet app. A
 * `javascript:` or `data:` URI there is a script-execution primitive aimed at
 * whatever renders it, and no legitimate interaction link needs either.
 */
const UNSAFE_SCHEMES: ReadonlySet<string> = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
]);

/**
 * Bearer shapes seen in this repository, plus the two universal ones.
 *
 * `osc_clm_` is the claim-token prefix the client CLI checks for before it
 * will poll (`packages/sdk-cli/src/control-plane.ts`); `eyJ` is a base64url
 * `{"` and therefore the opening of every JOSE object in existence; `Bearer `
 * is what a header looks like when somebody pastes a whole curl invocation
 * into a display row; and a PEM header is a private key that got copied from
 * the wrong buffer.
 *
 * Worth stating explicitly because it looks like a contradiction: the Save to
 * Google Wallet link *is* a JWT, and it does not trip this rule, because the
 * rule runs over the pass object *before* it becomes the payload of that JWT.
 * The signing envelope is built around a payload that has already been cleared.
 */
const CREDENTIAL_MARKERS: ReadonlyArray<{ pattern: RegExp; detail: string }> = [
  {
    pattern: /osc_clm_/u,
    detail: "value contains an OpenSesame claim-token prefix",
  },
  {
    pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/u,
    detail: "value contains a JWT",
  },
  {
    pattern: /eyJ[A-Za-z0-9_+/=-]{20,}/u,
    detail: "value contains base64-encoded JSON",
  },
  {
    pattern: /\bbearer\s+[\w.~+/=-]{8,}/iu,
    detail: "value contains a Bearer credential",
  },
  {
    pattern: /-----BEGIN [A-Z0-9 ]+-----/u,
    detail: "value contains a PEM block",
  },
];

/** A long opaque run: hex or base64url, the two shapes secrets are printed in. */
const HIGH_ENTROPY_RUN = /[A-Za-z0-9_-]{16,}/u;

/**
 * Maximal digit runs, tolerating the spaces and hyphens a printed card uses.
 *
 * `\p{Nd}` rather than `\d`, because `\d` under `/u` is ASCII-only and a card
 * number typed on a keyboard that produces full-width or Arabic-Indic digits is
 * still a card number to the human reading it off a lock screen. The matched
 * digits are folded to ASCII by `foldDigits` before the check digit is
 * computed.
 *
 * The surrounding `[^\d]`-anchored lookarounds are handled by scanning with a
 * global regex over the whole value and then inspecting the characters either
 * side of each match, because a JavaScript lookbehind is not available on every
 * runtime this package may end up on.
 */
const SPACED_DIGIT_RUN = /\p{Nd}(?:[ -]?\p{Nd}){11,}/gu;

/**
 * A card number written with dots between its groups.
 *
 * `4111.1111.1111.1111` is how a card looks when somebody has typed it into a
 * field that reformats, and it escapes `SPACED_DIGIT_RUN` entirely: no run of
 * twelve digits exists in it. Requiring at least three groups of three-to-six
 * digits keeps ordinary dotted numbers out — an IPv4 address maxes out at
 * twelve digits, a version string's groups are too short, and an OID's are
 * shorter still.
 */
const DOT_GROUPED_DIGITS = /\p{Nd}{3,6}(?:\.\p{Nd}{3,6}){2,5}/gu;

/** One Unicode decimal digit, for the code-point fold below. */
const DECIMAL_DIGIT = /^\p{Nd}$/u;

/** Characters that make an adjacent digit run part of a larger token. */
const TOKEN_CHARACTER = /[A-Za-z0-9_.-]/u;

/**
 * The tail of a dotted resource identifier: a dot, then a component that is
 * not itself just a number.
 */
const IDENTIFIER_TAIL = /^\.[A-Za-z0-9_-]*[A-Za-z_-]/u;

/**
 * The numeric value of one Unicode decimal digit.
 *
 * Unicode guarantees that every decimal-digit set is ten consecutive code
 * points beginning with its own zero, so the value of a digit is the number of
 * steps back to the first code point that is no longer a decimal digit. That
 * property is why no table is needed here and why the fold covers scripts
 * nobody thought to enumerate.
 */
function decimalValue(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  let value = 0;
  while (
    value < 9 &&
    DECIMAL_DIGIT.test(String.fromCodePoint(code - value - 1))
  ) {
    value += 1;
  }
  return value;
}

/** Drop the separators a printed card carries and fold its digits to ASCII. */
function foldDigits(run: string): string {
  let digits = "";
  for (const character of run) {
    if (character === " " || character === "-" || character === ".") continue;
    digits += String(decimalValue(character));
  }
  return digits;
}

/**
 * Is this digit run the leading component of a dotted resource identifier?
 *
 * The rule this replaces skipped any digit run with a `.` on either side, which
 * is far too much: `Charged to 4111111111111111.` is a card number followed by
 * a full stop, `4111111111111111.00` is a card number followed by a decimal
 * amount, and `v1.4111111111111111` is a card number hidden behind something
 * version-shaped. All three were skipped, and all three are exactly what the
 * rule exists to catch.
 *
 * What actually distinguishes a Google resource id is its *shape*: the digits
 * are the first component of a dotted token — `{issuerId}.{classSuffix}`,
 * `{issuerId}.{objectDigest}` — and the component after the dot is a name, not
 * a number. So the skip now demands all three of those things: the run opens a
 * token, a dot follows it immediately, and the component after the dot holds at
 * least one character no number would. A sentence-ending full stop has nothing
 * after it, `.00` is all digits, and `v1.` puts the digits in second place, so
 * none of the three is skipped any more.
 */
function opensDottedIdentifier(
  value: string,
  start: number,
  end: number,
): boolean {
  const before = value[start - 1];
  if (before !== undefined && TOKEN_CHARACTER.test(before)) return false;
  return IDENTIFIER_TAIL.test(value.slice(end));
}

/** Every digit sequence in a value that is worth testing as a card number. */
function panCandidates(value: string): string[] {
  const candidates: string[] = [];
  for (const match of value.matchAll(SPACED_DIGIT_RUN)) {
    const run = match[0] ?? "";
    const start = match.index ?? 0;
    if (opensDottedIdentifier(value, start, start + run.length)) continue;
    candidates.push(foldDigits(run));
  }
  for (const match of value.matchAll(DOT_GROUPED_DIGITS)) {
    candidates.push(foldDigits(match[0] ?? ""));
  }
  return candidates;
}

/** One card network's issuer-identification prefixes and issued lengths. */
interface PanNetwork {
  /** Named for the reader. It never appears in an error message. */
  readonly network: string;
  /** Anchored prefix test, applied to the folded ASCII digits. */
  readonly prefix: RegExp;
  /** The total lengths this network actually issues. */
  readonly lengths: readonly number[];
}

/**
 * Issuer-network prefixes, by network and by length.
 *
 * A plain "13–19 digits that pass Luhn" test is the obvious implementation and
 * it is wrong here: exactly one digit string in ten passes Luhn, so that rule
 * would refuse roughly a tenth of everything numeric a pass ever carries.
 * Requiring a real issuer-identification prefix as well as a valid check digit
 * is what keeps the rule precise enough to leave switched on.
 *
 * It is worth being exact about how much precision that buys, because an
 * earlier version of this comment claimed the prefix requirement was what kept
 * nineteen-digit Google issuer ids out of the Visa branch, and it measurably is
 * not. Over 40,000 samples each, against this table (`payload.test.ts` pins the
 * headline three with a seeded generator so they cannot drift unnoticed):
 *
 * - **10.15%** of random nineteen-digit strings beginning with `4` are flagged.
 *   The Visa prefix is a single digit, so for that branch the prefix test buys
 *   nothing whatsoever and the check digit is the entire filter — one in ten,
 *   exactly as a bare Luhn test would.
 * - **2.60%** of arbitrary random nineteen-digit strings, 2.54% of sixteen-digit,
 *   1.19% of fifteen-digit, and 1.00% of thirteen-digit. The nineteen-digit
 *   figure was 1.2% before this table grew; the rest is what covering Maestro,
 *   nineteen-digit Mastercard, sixteen-digit Diners, Elo, Hipercard, Dankort,
 *   Mir, and UATP costs.
 * - **0%** of `{nineteen-digit issuer id}.{suffix}` values — the shape every
 *   Google class id and object id in a real pass actually has — are flagged,
 *   including when the issuer id begins with `4`.
 *
 * That last line is the one that matters, and the prefix table is not what
 * produces it: a bare nineteen-digit issuer id beginning with `4` trips the Visa
 * branch one time in ten. What keeps issuer ids out of this rule is
 * `opensDottedIdentifier`, which recognises the dotted resource-identifier shape
 * they are always written in. Anyone tempted to relax that function should read
 * those numbers first: it, and not the prefix list, is what stops this gate
 * refusing a tenth of all deployments.
 *
 * Deliberately absent: RuPay (`60`, `81`, `82`), Troy (`9792`), and Verve. Their
 * prefixes are one or two digits wide over ranges that ordinary reference
 * numbers occupy, so each would cost about a percent of arbitrary digit strings
 * for a network whose cards are very unlikely to be described in an OpenSesame
 * approval. This is a documented gap, not an oversight — payment *credentials*
 * are out of scope for OpenSesame entirely (ADR 0086 §6), and this rule is a
 * backstop against a caller pasting one in, not a PCI-grade card detector.
 */
const PAN_NETWORKS: ReadonlyArray<PanNetwork> = [
  { network: "Visa", prefix: /^4/u, lengths: [13, 16, 19] },
  {
    network: "Mastercard",
    prefix: /^(?:5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/u,
    lengths: [16, 19],
  },
  { network: "American Express", prefix: /^3[47]/u, lengths: [15] },
  // Diners Club International and the sixteen-digit US Diners cards a
  // fourteen-digit-only rule missed entirely.
  {
    network: "Diners Club",
    prefix: /^3(?:0[0-5]|095|[68])/u,
    lengths: [14, 16, 19],
  },
  { network: "Discover", prefix: /^6(?:011|5|4[4-9])/u, lengths: [16, 19] },
  { network: "JCB", prefix: /^35(?:2[89]|[3-8]\d)/u, lengths: [16, 19] },
  // JCB's legacy fifteen-digit ranges, which share Amex's length but not its
  // prefix.
  { network: "JCB (legacy)", prefix: /^(?:2131|1800)/u, lengths: [15] },
  { network: "UnionPay", prefix: /^62/u, lengths: [16, 17, 18, 19] },
  // Maestro is the widest length range in issue, and every one of its prefixes
  // is four digits, so covering all of them costs almost nothing in precision.
  {
    network: "Maestro",
    prefix: /^(?:5018|5020|5038|5893|6304|6759|676[1-3])/u,
    lengths: [12, 13, 14, 15, 16, 17, 18, 19],
  },
  { network: "Dankort", prefix: /^5019/u, lengths: [16] },
  {
    network: "Elo",
    prefix: /^(?:50(?:41|6[67])|509\d|6277|636[23])/u,
    lengths: [16],
  },
  { network: "Hipercard", prefix: /^6062/u, lengths: [16] },
  { network: "Mir", prefix: /^220[0-4]/u, lengths: [16, 17, 18, 19] },
  // The broadest entry in the table by a wide margin: UATP is one leading digit
  // over fifteen, so it flags one arbitrary fifteen-digit string in a hundred.
  // Kept because a UATP number is a real payment credential and a fifteen-digit
  // run is rare in a pass; named here so the cost is visible rather than
  // discovered.
  { network: "UATP", prefix: /^1/u, lengths: [15] },
];

/** The Luhn check digit. A PAN that fails it is a typo, not a card. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = digits.charCodeAt(index) - 48;
    const scaled = double ? digit * 2 : digit;
    sum += scaled > 9 ? scaled - 9 : scaled;
    double = !double;
  }
  return sum % 10 === 0;
}

function looksLikePan(digits: string): boolean {
  const matched = PAN_NETWORKS.some(
    (network) =>
      network.lengths.includes(digits.length) && network.prefix.test(digits),
  );
  if (!matched) return false;
  return passesLuhn(digits);
}

/**
 * Refuse a field name that names credential material.
 *
 * The name itself appears in the error: field names are structure, not
 * content, and an operator cannot fix the problem without being told which
 * field it is. It goes through `displayName` first, because a "field name" here
 * may be a display-row label somebody typed. The *value* never appears
 * anywhere.
 */
function assertKeySafe(key: string, path: string): void {
  const normalized = normalizeName(key);
  if (CARD_VERIFICATION_NAMES.has(normalized)) {
    throw new WalletPayloadRejected(
      "card_verification_value",
      path,
      `field "${displayName(key)}" names a card verification value`,
    );
  }
  if (FORBIDDEN_KEY_NAMES.has(normalized)) {
    throw new WalletPayloadRejected(
      "forbidden_key",
      path,
      `field "${displayName(key)}" names credential material`,
    );
  }
}

/**
 * Refuse a URL-shaped value that carries a forbidden parameter.
 *
 * Both halves matter. The query string is the obvious carrier and the one that
 * ends up in vendor access logs and `Referer` headers. The fragment is the
 * less obvious one: it never reaches a server, which is exactly why link
 * builders reach for it when they want to smuggle a bearer, and a pass is a
 * *client-side* artifact where the fragment is fully readable.
 *
 * A value that is not a URL at all is not an error — most values are titles.
 */
function assertUrlSafe(value: string, path: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (UNSAFE_SCHEMES.has(url.protocol)) {
    throw new WalletPayloadRejected(
      "unsafe_url_scheme",
      path,
      `URL scheme "${displayName(url.protocol)}" is not renderable safely in a wallet`,
    );
  }
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const carriers: ReadonlyArray<{ where: string; params: URLSearchParams }> = [
    { where: "query", params: url.searchParams },
    { where: "fragment", params: new URLSearchParams(fragment) },
  ];
  for (const carrier of carriers) {
    for (const [name] of carrier.params) {
      if (FORBIDDEN_KEY_NAMES.has(normalizeName(name))) {
        throw new WalletPayloadRejected(
          "forbidden_url_param",
          path,
          `URL ${carrier.where} carries the forbidden parameter "${displayName(name)}"`,
        );
      }
    }
  }
}

/**
 * Every content rule, applied to one leaf.
 *
 * Non-string leaves are stringified before they get here rather than skipped:
 * a sixteen-digit card number is just as much a card number when JSON typed it
 * as a number, and a rule that only looked at strings would be defeated by
 * dropping a pair of quotes.
 *
 * `label` is the nearest field name that owns this leaf, which is not always
 * the field name that introduced it. Inside an array there is no name of one's
 * own — `secretData[0]` is only ever `[0]` — and an earlier version of this
 * file therefore passed `null` for every array element, so `{ secretData: "…" }`
 * was refused and `{ secretData: ["…"] }` was issued. Wrapping a value in
 * brackets is not a change of meaning, so the owning name follows the value
 * down through however many arrays it is nested in.
 */
function assertLeafSafe(
  value: string,
  label: string | null,
  path: string,
): void {
  for (const marker of CREDENTIAL_MARKERS) {
    if (marker.pattern.test(value)) {
      throw new WalletPayloadRejected("bearer_shape", path, marker.detail);
    }
  }

  for (const candidate of panCandidates(value)) {
    if (looksLikePan(candidate)) {
      throw new WalletPayloadRejected(
        "primary_account_number",
        path,
        "value contains a primary account number",
      );
    }
  }

  assertUrlSafe(value, path);

  if (label === null) return;
  const labelled = nameWords(label).some((word) =>
    CREDENTIAL_LABEL_WORDS.has(word),
  );
  if (labelled && HIGH_ENTROPY_RUN.test(value)) {
    throw new WalletPayloadRejected(
      "labelled_high_entropy",
      path,
      `field "${displayName(label)}" is named for credential material and holds an opaque run`,
    );
  }
}

/** A structural tag (`Map`, `Date`) — never a value — for a refusal message. */
function typeTag(node: BoundaryValue): string {
  const tag = Object.prototype.toString.call(node);
  return displayName(tag.slice("[object ".length, -1));
}

/**
 * An object whose prototype is `Object.prototype` or nothing at all.
 *
 * The prototype is the discriminator rather than a list of classes to refuse,
 * because the list would be a list of the classes somebody thought of. `Map`,
 * `Set`, `Date`, a typed array, an `Error`, and a domain object built by a
 * caller are all one question — "did this come out of an object literal or out
 * of a constructor" — and only the literal answers for its own contents.
 */
function isPlainObject(node: BoundaryValue): boolean {
  const prototype: BoundaryValue = Object.getPrototypeOf(node);
  return prototype === null || prototype === Object.prototype;
}

/**
 * Refuse anything in the payload that is not plain JSON data.
 *
 * This walk is about honesty rather than secrecy — the content walk below is
 * what stops a credential — and it earns its place because the difference
 * between an object and its serialization is where surprises live. A `Map`
 * serializes to `{}`, a `Set` to `{}`, an `ArrayBuffer` to `{}`, an `Error` to
 * `{}`: each one silently discards everything it held, so a caller who put a
 * value somewhere ends up with a pass that quietly does not contain it. A value
 * carrying `toJSON` is worse than lossy — it decides for itself what the
 * serializer sees, which is precisely the substitution property 3 exists to
 * defeat. A `Date` is refused with the rest even though it serializes
 * faithfully, because "a pass payload is JSON data" is a rule a future reader
 * can apply without consulting a table of exceptions.
 *
 * `visited` skips a node already checked rather than refusing it. Sharing one
 * object from two places is ordinary — a caller building two display rows from
 * the same record does it without noticing — and an earlier version of this
 * file called that a cycle and refused the pass. Genuine cycles are caught by
 * the serializer itself, which cannot be fooled about whether its own output
 * terminates.
 */
function assertJsonData(payload: BoundaryValue): void {
  const visited = new WeakSet<object>();
  const stack: Array<{ node: BoundaryValue; path: string }> = [
    { node: payload, path: "$" },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const node = frame.node;
    if (node === null) continue;
    if (isString(node) || isNumber(node) || isBoolean(node)) continue;
    // `undefined`, a function, and a symbol all serialize to nothing at all,
    // so none of the three can leak — but they are not the same mistake.
    // `undefined` is how an optional field says it is unset, and refusing it
    // would make this gate reject payloads a caller assembled correctly; a
    // function or a symbol in a pass is somebody's bug, and a bug that silently
    // drops a field is worth hearing about at the call site.
    if (isUndefined(node)) continue;
    if (isBigint(node)) {
      throw new WalletPayloadRejected(
        "non_json_value",
        frame.path,
        "a bigint is not JSON data; JSON.stringify refuses to serialize one",
      );
    }
    if (isSymbol(node) || isFunction(node)) {
      throw new WalletPayloadRejected(
        "non_json_value",
        frame.path,
        `a ${typeTag(node)} is not JSON data and would be dropped silently`,
      );
    }
    if (!isTypeofObject(node)) {
      throw new WalletPayloadRejected(
        "non_json_value",
        frame.path,
        `a ${typeTag(node)} is not JSON data`,
      );
    }

    if (Array.isArray(node)) {
      if (visited.has(node)) continue;
      visited.add(node);
      const items: readonly BoundaryValue[] = node;
      items.forEach((child, index) => {
        stack.push({ node: child, path: `${frame.path}[${index}]` });
      });
      continue;
    }

    if (visited.has(node)) continue;
    visited.add(node);
    if (!isPlainObject(node)) {
      throw new WalletPayloadRejected(
        "non_json_value",
        frame.path,
        `a ${typeTag(node)} is not JSON data; a pass carries strings, numbers, booleans, arrays, and plain objects`,
      );
    }
    if ("toJSON" in node) {
      throw new WalletPayloadRejected(
        "non_json_value",
        frame.path,
        "a value defining toJSON chooses its own serialized form, which is not the form this check inspected",
      );
    }
    // Descriptors rather than `Object.entries`, because reading the values is
    // the thing being decided. An accessor answers a question rather than
    // holding an answer, and it may answer differently each time it is asked —
    // once for this gate's serialization and once for the signer's. Refusing
    // accessors, like refusing `toJSON` above, is what makes those two
    // serializations the same bytes for every payload this gate accepts, rather
    // than merely the same bytes most of the time. `Object.keys` is the set
    // `JSON.stringify` will visit, and asking for it invokes nothing.
    const descriptors = Object.getOwnPropertyDescriptors(node);
    for (const childKey of Object.keys(node)) {
      const descriptor = descriptors[childKey];
      if (descriptor === undefined) continue;
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new WalletPayloadRejected(
          "non_json_value",
          `${frame.path}.${displayName(childKey)}`,
          "an accessor property is not JSON data; it can answer one thing to this check and another to the signer",
        );
      }
      const childValue: BoundaryValue = descriptor.value;
      stack.push({
        node: childValue,
        path: `${frame.path}.${displayName(childKey)}`,
      });
    }
  }
}

/**
 * The exact text that will be signed, or a typed refusal.
 *
 * Every way `JSON.stringify` can fail becomes a refusal rather than an escaped
 * exception. A cycle throws a `TypeError` and a structure nested past the
 * engine's recursion limit throws a `RangeError`; either one escaping from a
 * mandatory gate would look like a crash on the issue path, and a crash on the
 * issue path gets "fixed" by deleting the call rather than by finding the
 * cycle.
 */
function serializeOrRefuse(payload: BoundaryValue): string | undefined {
  try {
    return JSON.stringify(payload);
  } catch {
    throw new WalletPayloadRejected(
      "cyclic_payload",
      "$",
      "the payload cannot be serialized to JSON; it refers back to itself or nests too deeply",
    );
  }
}

/**
 * Apply every content rule to the parsed form of the emitted JSON.
 *
 * The walk is iterative because it runs on data assembled by other code, and a
 * recursive walker over an attacker-influenced structure is a stack overflow
 * waiting to happen. It needs no cycle detection of its own: `JSON.parse`
 * cannot produce a cycle, and it hands back a fresh tree in which two shared
 * nodes have become two independent ones — so a payload that reuses an object
 * is checked twice rather than mistaken for a loop.
 */
function assertEmittedSafe(root: BoundaryValue): void {
  const stack: Array<{
    node: BoundaryValue;
    key: string | null;
    label: string | null;
    path: string;
  }> = [{ node: root, key: null, label: null, path: "$" }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.key !== null) assertKeySafe(frame.key, frame.path);

    if (Array.isArray(frame.node)) {
      const items: readonly BoundaryValue[] = frame.node;
      items.forEach((child, index) => {
        stack.push({
          node: child,
          key: null,
          // The array is not a name; whatever named the array still names what
          // is inside it.
          label: frame.label,
          path: `${frame.path}[${index}]`,
        });
      });
      continue;
    }

    if (isJsonObject(frame.node)) {
      for (const [childKey, childValue] of Object.entries(frame.node)) {
        stack.push({
          node: childValue,
          key: childKey,
          label: childKey,
          path: `${frame.path}.${displayName(childKey)}`,
        });
      }
      continue;
    }

    assertLeafSafe(String(frame.node), frame.label, frame.path);
  }
}

/**
 * Walk a pass payload and refuse anything that must not be published.
 *
 * Three passes, in this order and for these reasons. `assertJsonData` walks the
 * live object graph and refuses anything that is not JSON data, so the
 * structure a reader sees in the source is the structure that gets serialized.
 * `serializeOrRefuse` produces the exact text that will be signed, turning a
 * cycle into a typed refusal on the way. `assertEmittedSafe` then applies every
 * content rule to `JSON.parse` of that text — the bytes themselves, not the
 * object they came from — so no accessor, `toJSON`, or `Proxy` can show the
 * check one value and the signer another.
 *
 * The parameter is `BoundaryValue` — the repository's named type for a value
 * arriving at an edge, the same one `canonicalize` takes for the same reason.
 * A narrower domain type would assume the answer this function exists to
 * decide, and a bare `unknown` would discard the type evidence a caller
 * already has. `BoundaryValue` is wide enough to admit anything a serializer
 * might hand over, including the exotic values (a `Date`, a `Map`, a
 * `Uint8Array`) whose presence in a pass is itself worth refusing.
 */
export function assertPassPayloadSafe(payload: BoundaryValue): void {
  assertJsonData(payload);
  const emitted = serializeOrRefuse(payload);
  // `undefined` means the payload emits no JSON at all — `undefined` itself, a
  // function, a symbol. Nothing is published, so there is nothing to inspect.
  if (emitted === undefined) return;
  const scanned: BoundaryValue = JSON.parse(emitted);
  assertEmittedSafe(scanned);
}
