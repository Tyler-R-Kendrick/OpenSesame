/**
 * Every message that crosses a boundary into the companion, decoded here and
 * nowhere else: what the popup and the guard send the background, what the
 * background sends the guard, what each answers, what the daemon answers,
 * and what storage hands back. A payload that does not decode is refused,
 * never narrowed by hand.
 *
 * `zod/mini`: the guard runs on every page of a switched-on site, so the
 * decoder it carries stays small.
 */
import * as z from "zod/mini";
import { ARM_MESSAGE, FILL_MESSAGE, PAIR_MESSAGE } from "./protocol";

const bounded = (max: number) => z.string().check(z.maxLength(max));
const CODE = bounded(64);
const ORIGIN = bounded(512);
const NONCE = bounded(128);
const REFERENCE = bounded(256);

export const fillField = z.enum(["password", "username"]);

/** Background → guard, in frame 0 of the tab a person gestured on. */
export const armMessage = z.object({
  type: z.literal(ARM_MESSAGE),
  /** `probe` asks only whether a passkey is offered; it never fills. */
  mode: z.enum(["fill", "probe"]),
  nonce: NONCE,
  origin: ORIGIN,
  trigger: bounded(32),
  armedAt: z.number(),
});
export type ArmMessage = z.infer<typeof armMessage>;

/** Guard → background: the one request whose answer holds a value. */
export const valueRequest = z.object({
  type: z.literal(FILL_MESSAGE),
  op: z.literal("value"),
  nonce: NONCE,
  field: fillField,
});
export type ValueRequest = z.infer<typeof valueRequest>;

/** Popup → background. None of these carries or returns a value. */
export const popupRequest = z.discriminatedUnion("op", [
  z.object({ type: z.literal(FILL_MESSAGE), op: z.literal("status") }),
  z.object({
    type: z.literal(FILL_MESSAGE),
    op: z.literal("trigger"),
    reference: z.optional(REFERENCE),
  }),
  z.object({
    type: z.literal(FILL_MESSAGE),
    op: z.literal("enable"),
    origin: ORIGIN,
  }),
  z.object({ type: z.literal(FILL_MESSAGE), op: z.literal("disable") }),
]);
export type PopupRequest = z.infer<typeof popupRequest>;

/** Everything the background accepts on `opensesame.fill`. */
export const fillRequest = z.union([valueRequest, popupRequest]);
export type FillRequest = z.infer<typeof fillRequest>;

export const pairRequest = z.object({ type: z.literal(PAIR_MESSAGE) });
export type PairRequest = z.infer<typeof pairRequest>;

/** The guard's answer to an arm: an outcome code, or a passkey probe. */
export const guardReply = z.object({
  outcome: z.optional(CODE),
  passkey: z.optional(z.boolean()),
});
export type GuardReply = z.infer<typeof guardReply>;

/** The background's answer to a value request. */
export const valueReply = z.union([
  z.object({ value: z.string() }),
  z.object({ refusal: CODE }),
]);
export type ValueReply = z.infer<typeof valueReply>;

/** What the popup draws. Names of entries, never a value. */
export const fillStatus = z.object({
  origin: z.nullable(ORIGIN),
  /** The person switched autofill on for exactly this origin. */
  enabled: z.boolean(),
  references: z.array(REFERENCE),
  passkey: z.boolean(),
  /** `not_paired`, `plugin_off`, `daemon_unreachable`, … */
  error: z.optional(CODE),
});
export type FillStatus = z.infer<typeof fillStatus>;

export const outcomeReply = z.object({ outcome: CODE });
export type OutcomeReply = z.infer<typeof outcomeReply>;

export const errorReply = z.object({ error: CODE });
export type ErrorReply = z.infer<typeof errorReply>;

export const pairState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("paired") }),
  z.object({ state: z.literal("pending"), code: bounded(16) }),
]);
export type PairState = z.infer<typeof pairState>;

const UNREACHABLE: ErrorReply = { error: "background_unavailable" };

/** Popup's decode of a status-bearing reply; anything else is an error. */
export const statusReply = z.catch(
  z.union([fillStatus, errorReply]),
  UNREACHABLE,
);

/** Popup's decode of a fill key's reply. */
export const triggerReply = z.catch(
  z.union([outcomeReply, errorReply]),
  UNREACHABLE,
);

/** Popup's decode of the pairing key's reply. */
export const pairReply = z.catch(z.union([pairState, errorReply]), UNREACHABLE);

/** The daemon's refusal body; a bare 404 has none. */
export const daemonRefusal = z.object({ error: CODE });

export const daemonMatch = z.object({
  // A reference that is not a string is dropped, not trusted.
  references: z
    .array(z.catch(z.optional(REFERENCE), undefined))
    .check(z.maxLength(64)),
});

export const daemonValue = z.object({ field: fillField, value: z.string() });

/** A stored string, or absent: anything else a key holds reads as absent. */
export const storedString = z.catch(z.optional(z.string()), undefined);

/** The switched-on origin list; an entry that is not a string is dropped. */
export const storedOrigins = z.catch(
  z.array(z.catch(z.optional(ORIGIN), undefined)),
  [],
);
