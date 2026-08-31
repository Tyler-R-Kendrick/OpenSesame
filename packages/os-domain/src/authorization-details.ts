/**
 * RFC 9396 authorization details, and the line between authorizing a payment
 * and storing a payment instrument (ADR 0086).
 *
 * OpenSesame already speaks `authorization_details`: ADR 0046 made it the
 * delegation constraint, the approval prompt, the enforcement predicate and
 * the consent echo all at once. This module adds the two things a wallet-facing
 * interaction layer needs on top.
 *
 * The first is a *typed* transaction shape. "Approve this API call" and
 * "approve this payment" want the same machinery — a frozen request, a digest,
 * a proof bound to it — but a payment carries an amount and a payee, and those
 * are exactly the fields a user must be shown and exactly the fields an
 * attacker wants to move after the fact.
 *
 * The second is a refusal. An authorization detail says *permission to
 * initiate a payment-like operation*; it is not a place to put a card. That
 * distinction is easy to state and easy to erode one field at a time, so it is
 * enforced mechanically here rather than left to review: card data entering an
 * authorization detail is a typed error on the way in, not a finding later.
 * OpenSesame is not a card-on-file service, does not provision DPANs, and
 * touching PAN/CVV would pull the whole system into PCI DSS scope for no
 * product reason.
 */

import { DomainError } from "./errors.js";
import {
  type JsonObject,
  type JsonValue,
  isString,
  isTypeofObject,
  overlapCast,
} from "./json.js";

/**
 * An RFC 9396 authorization detail.
 *
 * The known members are the ones the RFC names; everything else is an
 * extension member and is preserved verbatim, because the digest is computed
 * over the whole object. Dropping an unknown field on the way in would mean
 * the approver saw something the executor never hashes.
 */
export interface AuthorizationDetail extends JsonObject {
  type: string;
}

export interface MonetaryAmount extends JsonObject {
  /** ISO 4217 alphabetic code, uppercase. */
  currency: string;
  /** Decimal string. Never a float: 143.72 is not representable in binary. */
  value: string;
}

export interface TransactionPayee extends JsonObject {
  display_name: string;
}

/**
 * A payment-like operation awaiting authorization.
 *
 * `payment_initiation` is deliberately the same vocabulary the open-banking
 * ecosystem uses for a payment *instruction*, not for a card credential.
 */
export interface PaymentInitiationDetail extends AuthorizationDetail {
  type: "payment_initiation";
  amount: MonetaryAmount;
  payee: TransactionPayee;
}

/**
 * Field names that must never appear anywhere inside an authorization detail.
 *
 * Deny-first and matched against normalized keys, so `cardNumber`, `card_number`
 * and `CARD-NUMBER` are one rule. The list covers the card-data families PCI
 * DSS calls account data: the PAN itself, the expiry, the verification value
 * under each brand's name for it, and the magnetic-stripe/chip track data that
 * carries all of them at once.
 */
const FORBIDDEN_DETAIL_KEYS: readonly RegExp[] = [
  /^pan$/,
  /^(?:card|credit ?card|debit ?card)(?:number|no|num)?$/,
  /^(?:primary)?accountnumber$/,
  /^cvv2?$/,
  /^cvc2?$/,
  /^cid$/,
  /^csc$/,
  /^cav2?$/,
  /^(?:card)?(?:security|verification)(?:code|value)$/,
  /^(?:card)?expiry(?:date|month|year)?$/,
  /^(?:card)?exp(?:date|month|year|iration)?$/,
  /^track[12]?data$/,
  /^magstripe$/,
  /^dpan$/,
  /^networktoken$/,
  /^cryptogram$/,
  /^emvdata$/,
];

/**
 * Issuer identification numbers, as prefixes.
 *
 * Luhn alone is not a PAN test. Roughly one in ten arbitrary digit strings of
 * the right length passes it, so a Luhn-only rule refuses invoice numbers,
 * order ids and account references at a rate that gets the whole guard
 * switched off — and a guard that has been switched off protects nothing.
 *
 * Requiring a real issuer prefix as well costs no true positives worth having:
 * every card a payment network will route carries one of these. The pairing of
 * "starts like a card" and "checksums like a card" is what makes a match mean
 * something.
 */
const ISSUER_PREFIXES =
  /^(?:4|5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720)|3[47]|3(?:0[0-5]|[689])|6(?:011|5|4[4-9]|22)|35(?:2[89]|[3-8])|62)/;

/**
 * Recognise a PAN hiding in a free-text value.
 *
 * Two independent signals, both required: an issuer prefix and a Luhn
 * checksum. Separators are tolerated because a human pasting a card number
 * pastes the spaces too, which is exactly the case this catches.
 */
function looksLikePan(value: string): boolean {
  const digits = value.replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  if (!ISSUER_PREFIXES.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, "");
}

export class PaymentCredentialRefused extends DomainError {
  constructor(detail: string) {
    super("INVARIANT_VIOLATION", `payment credential refused: ${detail}`, {});
    this.name = "PaymentCredentialRefused";
  }
}

/**
 * How deep a legitimate authorization detail ever goes.
 *
 * RFC 9396 details are shallow — a type, some arrays of strings, an amount and
 * a payee. Sixty-four levels is far past anything real and far short of the
 * runtime's stack, which is the point: the bound exists so that hostile input
 * meets a typed refusal instead of a `RangeError`.
 */
const MAX_DETAIL_DEPTH = 64;

/** Keeps a refusal message from growing with the object that caused it. */
const MAX_PATH_LENGTH = 256;

function extendPath(path: string, segment: string): string {
  if (path.length >= MAX_PATH_LENGTH) return path;
  // Truncate the result rather than only declining to extend: a single key can
  // itself be longer than the cap, so checking the length beforehand still
  // lets one oversized segment through.
  const joined = `${path}${segment}`;
  return joined.length <= MAX_PATH_LENGTH
    ? joined
    : `${joined.slice(0, MAX_PATH_LENGTH)}…`;
}

interface PendingNode {
  value: JsonValue;
  path: string;
  depth: number;
}

/**
 * Refuse card data anywhere in an authorization detail tree.
 *
 * Two rules, because either alone is porous. The key rule catches a field
 * *named* like a card field regardless of what is in it. The value rule
 * catches a PAN placed under an innocuous name — `reference`, `note`,
 * `memo` — which is how card numbers actually end up in systems that never
 * meant to hold them.
 *
 * Iterative rather than recursive, with an explicit stack. This function runs
 * on the create path over a body an authenticated caller controls, and a
 * `.passthrough()` schema puts no bound on how deeply an extension member
 * nests. Recursion there turns 256 KiB of `[[[[…]]]]` into a stack overflow —
 * which is a 500 and an unhandled error type, rather than the 4xx a refusal
 * should be. The depth bound makes the refusal explicit and the cycle set
 * keeps a JS caller (this is exported) from looping forever on a structure
 * `JSON.parse` could never have produced.
 *
 * The error names the offending *path*, never the offending value: an
 * exception message is a log line, and a refusal that logs the card number is
 * worse than no refusal at all.
 */
export function assertNoPaymentCredentials(value: JsonValue, path = "$"): void {
  const pending: PendingNode[] = [{ value, path, depth: 0 }];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    const current = node.value;

    if (isString(current)) {
      if (looksLikePan(current)) {
        throw new PaymentCredentialRefused(
          `${node.path} carries a value shaped like a primary account number`,
        );
      }
      continue;
    }
    if (current === null || !isTypeofObject(current)) continue;

    if (node.depth >= MAX_DETAIL_DEPTH) {
      throw new PaymentCredentialRefused(
        `${node.path} nests deeper than ${MAX_DETAIL_DEPTH} levels, so it cannot be checked`,
      );
    }
    /*
     * SAFETY: the string and non-object branches above have returned, so what
     * remains is established to be an array or a plain object — both of which
     * a WeakSet accepts as keys.
     */
    const asObject: object = overlapCast(current);
    if (seen.has(asObject)) {
      throw new PaymentCredentialRefused(
        `${node.path} contains a cycle, so it cannot be checked`,
      );
    }
    seen.add(asObject);

    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) {
        const item = current[i];
        if (item !== undefined) {
          pending.push({
            value: item,
            path: extendPath(node.path, `[${i}]`),
            depth: node.depth + 1,
          });
        }
      }
      continue;
    }

    /*
     * SAFETY: the string, null, non-object and array branches above have all
     * continued, so what remains is established to be a plain JSON object and
     * `Object.entries` is total over it.
     */
    const entries = Object.entries(overlapCast(current));
    for (const [key, item] of entries) {
      const normalized = normalizeKey(key);
      if (FORBIDDEN_DETAIL_KEYS.some((rule) => rule.test(normalized))) {
        throw new PaymentCredentialRefused(
          `${extendPath(node.path, `.${key}`)} names card data, which never enters an authorization detail`,
        );
      }
      if (item !== undefined) {
        pending.push({
          value: item,
          path: extendPath(node.path, `.${key}`),
          depth: node.depth + 1,
        });
      }
    }
  }
}

/**
 * Longest a payee name may be.
 *
 * It is read off a phone screen by somebody deciding whether to pay, so it was
 * never going to be long. Bounding it here rather than only in the wire schema
 * matters because the name is interpolated into the binding message, which is
 * then stored, hashed and echoed — an unbounded name became an unbounded row.
 */
const MAX_DISPLAY_NAME = 140;

/**
 * Longest a derived binding message may be.
 *
 * Matches the bound the authorization-request inbox already places on the
 * messages it accepts (ADR 0046), so the two ceremonies cannot disagree about
 * what fits on a screen. Truncation is visible rather than silent: a reader
 * seeing the ellipsis knows the sentence was cut, which is the honest failure
 * mode for a string whose whole job is to be read.
 */
const MAX_BINDING_MESSAGE = 120;

function boundedMessage(message: string): string {
  return message.length <= MAX_BINDING_MESSAGE
    ? message
    : `${message.slice(0, MAX_BINDING_MESSAGE - 1)}…`;
}

const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Validate a payment-initiation detail.
 *
 * The amount is a decimal *string* with a bounded shape. Accepting a JSON
 * number here would mean the value displayed to the approver and the value
 * hashed into the digest could differ by a floating-point rounding — the
 * approver sees 143.72, the canonical form says 143.71999999999999, and the
 * two sides of a dynamic-linking check disagree for reasons no reviewer will
 * ever find. So the wire type is a string and stays one all the way through.
 */
export function assertPaymentInitiation(
  detail: AuthorizationDetail,
): asserts detail is PaymentInitiationDetail {
  assertNoPaymentCredentials(detail);
  const amount = detail.amount;
  if (!isTypeofObject(amount) || amount === null || Array.isArray(amount)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "payment_initiation requires an amount object",
    );
  }
  /*
   * SAFETY: `amount` was just checked to be a non-null, non-array object, so
   * destructuring it is sound. Both fields are validated below rather than
   * trusted — the assertion buys property access, never a type guarantee.
   */
  const { currency, value } = amount as JsonObject;
  if (!isString(currency) || !CURRENCY_PATTERN.test(currency)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "payment_initiation amount.currency must be an ISO 4217 alphabetic code",
    );
  }
  if (!isString(value) || !AMOUNT_PATTERN.test(value)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "payment_initiation amount.value must be a bounded decimal string",
    );
  }
  const payee = detail.payee;
  if (!isTypeofObject(payee) || payee === null || Array.isArray(payee)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "payment_initiation requires a payee object",
    );
  }
  /*
   * SAFETY: as above — `payee` was checked to be a non-null, non-array object,
   * and `display_name` is validated on the next line.
   */
  const displayName = (payee as JsonObject).display_name;
  if (isString(displayName) && displayName.length > MAX_DISPLAY_NAME) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      `payment_initiation payee.display_name exceeds ${MAX_DISPLAY_NAME} characters`,
    );
  }
  if (!isString(displayName) || displayName.length === 0) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "payment_initiation requires payee.display_name",
    );
  }
}

/**
 * Validate a whole `authorization_details` array.
 *
 * Every element is checked for card data whatever its type, because the
 * refusal is about the shape of the data and not about which operation
 * claimed to carry it.
 */
export function assertAuthorizationDetails(
  details: readonly AuthorizationDetail[],
): void {
  if (details.length === 0) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "authorization_details must not be empty",
    );
  }
  for (const detail of details) {
    if (!isString(detail.type) || detail.type.length === 0) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "every authorization detail needs a type",
      );
    }
    assertNoPaymentCredentials(detail);
    if (detail.type === "payment_initiation") {
      assertPaymentInitiation(detail);
    }
  }
}

/**
 * The words shown on both screens, derived from the details themselves.
 *
 * Derived rather than supplied, because a binding message a requester writes
 * freely is a binding message a requester can make disagree with what will
 * execute — "confirm your session" over a payment detail. Generating it from
 * the same object the digest covers is what keeps the sentence and the
 * operation the same fact.
 */
export function deriveBindingMessage(
  details: readonly AuthorizationDetail[],
): string {
  const first = details[0];
  if (first === undefined) return "Authorize request";
  if (first.type === "payment_initiation") {
    /*
     * SAFETY: this runs on details that may not have been validated yet — it
     * derives the words a user will read, and must not throw on a malformed
     * request before the validator has had its say. Every field read below is
     * checked with `isString`, and the optional chaining covers a non-object
     * shape, so the assertion widens access without widening trust.
     */
    const amount = first.amount as JsonObject | undefined;
    /* SAFETY: as above — the same unvalidated boundary, checked below. */
    const payee = first.payee as JsonObject | undefined;
    const currency = isString(amount?.currency) ? amount.currency : "";
    const value = isString(amount?.value) ? amount.value : "";
    const name = isString(payee?.display_name) ? payee.display_name : "payee";
    const extra = details.length > 1 ? ` (+${details.length - 1} more)` : "";
    return boundedMessage(`Pay ${value} ${currency} to ${name}${extra}`);
  }
  const actions = Array.isArray(first.actions)
    ? first.actions.filter(isString)
    : [];
  const action = actions[0] ?? first.type;
  const target = isString(first.identifier)
    ? first.identifier
    : ((Array.isArray(first.locations)
        ? first.locations.filter(isString)[0]
        : undefined) ?? "");
  const extra = details.length > 1 ? ` (+${details.length - 1} more)` : "";
  return boundedMessage(
    target ? `${action} on ${target}${extra}` : `${action}${extra}`,
  );
}
