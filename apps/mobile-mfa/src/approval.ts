import type { InteractionErrorCode } from "@opensesame/ceremony-kit";
import { renderInteractionSummary } from "@opensesame/ceremony-kit";
import type {
  ApprovalMechanism,
  AssuranceLevel,
  InteractionDetail,
  InteractionStatus,
} from "@opensesame/os-domain";

/**
 * The decisions an approval screen has to make, with no React in them.
 *
 * Three of them, and each is the kind of rule that quietly diverges when it
 * lives inline in a component: what counts as settled, which authenticator is
 * strong enough, and which of the rendered lines is the one the human is meant
 * to compare against the other device.
 */

/**
 * How the question ended, as far as this phone is concerned.
 *
 * A closed set rather than a status string, because three vocabularies arrive
 * here — `InteractionStatus` from a resolved interaction, `InteractionErrorCode`
 * from a refused call, and the link reader's own verdict — and they describe
 * the same handful of endings. Collapsing them once means the screen has one
 * thing to render and cannot end up with an "expired" branch that only fires
 * down one of the paths.
 *
 * `refused` is the odd one: it belongs to the *link*, not to any interaction,
 * and neither mapping below can produce it. It lives here anyway because it
 * ends the screen in exactly the same shape, and a second panel for it would
 * be a second place to get the announcement and the non-colour mark wrong.
 */
export type Outcome =
  | "approved"
  | "denied"
  | "consumed"
  | "expired"
  | "revoked"
  | "missing"
  | "refused";

/**
 * The word for each ending.
 *
 * ADR 0061's voice: the outcome, and nothing explaining what an outcome is.
 * "Already used" rather than "consumed" because the human did not consume
 * anything — somebody spent the approval, possibly them, a minute ago.
 */
export const OUTCOME_TEXT = {
  approved: "Approved",
  denied: "Denied",
  consumed: "Already used",
  expired: "Expired",
  revoked: "Withdrawn",
  missing: "Not found",
  refused: "Refused",
} as const satisfies Record<Outcome, string>;

/**
 * A glyph beside each word, so the ending is never carried by colour alone.
 *
 * `aria-hidden` at the call site: the word next to it is the accessible name,
 * and a screen reader announcing "check mark approved" is noise. The mark is
 * for the person who cannot tell the green panel from the red one.
 */
export const OUTCOME_MARK = {
  approved: "✓",
  denied: "✕",
  consumed: "◦",
  expired: "◦",
  revoked: "✕",
  missing: "?",
  refused: "✕",
} as const satisfies Record<Outcome, string>;

/** Whether an ending should read as a refusal rather than a resolution. */
export const OUTCOME_IS_REFUSAL = {
  approved: false,
  denied: true,
  consumed: false,
  expired: true,
  revoked: true,
  missing: true,
  refused: true,
} as const satisfies Record<Outcome, boolean>;

/**
 * Settled statuses only.
 *
 * `pending`, `presented` and `awaiting_approval` deliberately produce nothing:
 * they are the states in which the screen *is* the question, and captioning
 * the question with its own state is the prose ADR 0061 removed.
 */
export function outcomeOfStatus(
  status: InteractionStatus,
): Outcome | undefined {
  switch (status) {
    case "approved":
      return "approved";
    case "denied":
      return "denied";
    case "consumed":
      return "consumed";
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    default:
      return undefined;
  }
}

/**
 * The error codes that mean the question is over.
 *
 * `digest_mismatch`, `approval_required` and `rate_limited` are absent on
 * purpose: none of them ends anything. Treating a rate limit as a terminal
 * state would tell a human their request was settled when the truth is that
 * they should try again in a moment.
 */
export function outcomeOfErrorCode(
  code: InteractionErrorCode,
): Outcome | undefined {
  switch (code) {
    case "interaction_not_found":
      return "missing";
    case "interaction_expired":
      return "expired";
    case "interaction_revoked":
      return "revoked";
    case "interaction_consumed":
      return "consumed";
    case "approval_denied":
      return "denied";
    default:
      return undefined;
  }
}

/** A mechanism this phone can actually produce, with what it is worth. */
export interface Mechanism {
  mechanism: ApprovalMechanism;
  assurance: AssuranceLevel;
  /** Whether the human must type a current code to complete it. */
  needsCode: boolean;
}

const PASSKEY: Mechanism = {
  mechanism: "webauthn",
  assurance: "phishing_resistant",
  needsCode: false,
};

const REAUTH: Mechanism = {
  mechanism: "session_reauth",
  assurance: "mfa",
  needsCode: true,
};

/**
 * Pick the strongest approval this device can honestly produce.
 *
 * A ladder with a floor, not a preference list. The passkey rung is taken
 * whenever the platform offers one, because it is the only mechanism here that
 * is phishing-resistant and verifier-name-bound. The fallback rung still costs
 * a live TOTP code — never merely the session — because ADR 0086 §7 is
 * explicit that an authenticated session is not an approval.
 *
 * `undefined` is the important return: a request that needs a passkey on a
 * browser that has none cannot be approved from here, and offering the weaker
 * rung anyway would mint a proof claiming more than it proves.
 *
 * The rule is keyed on the interaction's *kind* rather than on
 * `assuranceRequired`. `InteractionDetail` declares that field, but
 * `@opensesame/ceremony-kit` deliberately does not decode it — the trust
 * vocabulary belongs to each surface's own step-up code rather than to a
 * transport — so a branch reading it here would be a branch that can never
 * run. `transaction_authorization` is the kind ADR 0086 §6 puts an amount
 * behind, and PSD2 dynamic linking is not something a code typed into a form
 * satisfies. Whatever this ladder picks, the server re-checks the proof it
 * receives; this is the floor, not the authority.
 */
export function chooseMechanism(
  detail: InteractionDetail,
  webauthnAvailable: boolean,
): Mechanism | undefined {
  if (webauthnAvailable) return PASSKEY;
  if (detail.kind === "transaction_authorization") return undefined;
  return REAUTH;
}

/** The rendered interaction, split for layout. */
export interface ApprovalView {
  title: string;
  /**
   * The binding message: the one string both devices show, and the one the
   * human is meant to compare. Given its own slot so it can be set apart from
   * the facts rather than becoming the first row of a list.
   */
  match?: string;
  facts: string[];
}

/**
 * Render an interaction for this screen.
 *
 * `renderInteractionSummary` emits the binding message first, and emits
 * nothing for it when the interaction has none or when sanitising left it
 * empty. Rather than re-deriving that rule — which would mean a second, always
 * slightly wrong copy of the kit's sanitiser living here — the renderer is
 * asked directly: render again without the binding message, and the line that
 * disappeared was it.
 *
 * Strings are returned for the caller to place in text nodes.
 * `renderInteractionSummary` deliberately returns plain text and never markup,
 * and the values inside it are chosen by whoever is asking for the approval.
 */
export function viewOf(detail: InteractionDetail): ApprovalView {
  const rendered = renderInteractionSummary(detail);
  const withoutBinding = renderInteractionSummary({
    ...detail,
    bindingMessage: undefined,
  });
  const carriesBinding = rendered.lines.length > withoutBinding.lines.length;
  return carriesBinding
    ? {
        title: rendered.title,
        match: rendered.lines[0],
        facts: rendered.lines.slice(1),
      }
    : { title: rendered.title, facts: rendered.lines };
}
