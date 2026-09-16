import { z } from "zod";

/**
 * Positive wire schemas for a transaction and its approval display (ADR 0086 §6).
 *
 * `os-domain`'s `authorization-details.ts` guards the create path by *refusing*
 * card data — a deny-list run over whatever arrives. That is the right shape
 * for "never store a payment instrument", but it is not a description of what a
 * valid payment *is*. This module is the positive half: the exact shape a
 * `payment_initiation` detail must have, and the exact shape of what the
 * approver is shown. A positive schema refuses by *omission* — a field the
 * schema does not name cannot appear — which is the complement the deny-list
 * cannot provide, and the two together are what keep the transaction model
 * closed at both ends.
 *
 * The amount is a decimal **string**, never a JSON number, for the reason the
 * digest layer states: `143.72` is not representable in binary, so a number
 * shown to the approver as `143.72` and hashed as `143.71999999999999` would
 * make the two sides of a dynamic-linking check disagree for a reason no
 * reviewer would ever find.
 */

/**
 * A bounded decimal amount.
 *
 * At most sixteen integer digits and four fractional, matching os-domain's
 * `AMOUNT_PATTERN`, so a value that passes the wire schema also passes the
 * domain validator and the two cannot drift into disagreeing about what a
 * legal amount is.
 */
export const MonetaryAmountSchema = z
  .object({
    /** ISO 4217 alphabetic code, uppercase. */
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** Decimal string. Never a float. */
    value: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/),
  })
  .strict();
export type MonetaryAmount = z.infer<typeof MonetaryAmountSchema>;

/**
 * A payee, reduced to the one field an approver reads.
 *
 * Bounded at 140 characters because the name is read off a phone screen and is
 * interpolated into the stored, hashed, echoed binding message — an unbounded
 * name is an unbounded row. Matches os-domain's `MAX_DISPLAY_NAME`.
 */
export const TransactionPayeeSchema = z
  .object({
    display_name: z.string().min(1).max(140),
  })
  .strict();
export type TransactionPayee = z.infer<typeof TransactionPayeeSchema>;

/**
 * A `payment_initiation` authorization detail, described positively.
 *
 * `.strict()` on the amount and payee refuses any extra member on those
 * objects — the place a PAN under an innocuous key would otherwise ride in —
 * while the detail itself stays open (`.passthrough()`) because RFC 9396
 * extension members are legitimate and the digest is computed over the whole
 * object. The card-data deny-list in os-domain still runs over the whole
 * detail; this schema narrows the two objects that have no reason to carry
 * anything but their named fields.
 */
export const PaymentInitiationDetailSchema = z
  .object({
    type: z.literal("payment_initiation"),
    amount: MonetaryAmountSchema,
    payee: TransactionPayeeSchema,
  })
  .passthrough();
export type PaymentInitiationDetail = z.infer<
  typeof PaymentInitiationDetailSchema
>;

/**
 * What the approver is shown for a transaction, and nothing else.
 *
 * The display is derived server-side from the operation and echoed for the
 * requester's own screen (CIBA identical-message discipline). It is a positive
 * shape so a surface cannot quietly render a field that was never part of what
 * gets hashed — the sentence on the screen and the operation in the digest are
 * the same fact, and a display schema that admitted extra fields would be a
 * place for them to diverge.
 */
export const TransactionDisplaySchema = z
  .object({
    /** The identical sentence shown on both devices. */
    bindingMessage: z.string().min(1).max(120),
    /** Present when the operation moves money. */
    amount: MonetaryAmountSchema.optional(),
    /** Present when the operation names a payee. */
    payee: TransactionPayeeSchema.optional(),
    /** The operation digest the display corresponds to, for the requester's echo. */
    operationDigest: z.string().min(16).max(256),
  })
  .strict();
export type TransactionDisplay = z.infer<typeof TransactionDisplaySchema>;
