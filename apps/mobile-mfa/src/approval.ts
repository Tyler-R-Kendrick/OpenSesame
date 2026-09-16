import type { InteractionErrorCode } from "@opensesame/ceremony-kit";
import { renderInteractionSummary } from "@opensesame/ceremony-kit";
import type {
  ApprovalMechanism,
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

/**
 * A step-up this phone can actually perform.
 *
 * No `assurance` field: the level an approval is worth is the server's to
 * decide, read off the interaction-scoped activation it verified, and a copy
 * asserted here would only be a claim the server never checked. What this type
 * carries is which authenticator to reach for, and nothing that would end up in
 * an audit row.
 */
export interface Mechanism {
  mechanism: ApprovalMechanism;
}

const PASSKEY: Mechanism = {
  mechanism: "webauthn",
};

/**
 * Pick the approval this device can honestly produce.
 *
 * WebAuthn or nothing. Approving an interaction is an authorization-assurance
 * decision, and the authority requires a phishing-resistant, interaction-scoped
 * WebAuthn activation (the server's `INTERACTION_APPROVAL_POLICY`): it issues
 * options whose challenge is bound to the request digest, verifies the raw
 * assertion itself, and only then mints the activation this screen spends. A
 * bare session — even one freshly re-authenticated with a TOTP code — is not an
 * approval (ADR 0086 §7), and the earlier "reauth" rung was exactly the
 * privileged-approval bypass this reconciliation removes (F01/A-04).
 *
 * `undefined` is the important return: a browser with no passkey cannot approve
 * from here, and offering a weaker rung anyway would step the human up to less
 * than the request demands and be refused as `proof_required` besides. A TOTP
 * rung with genuinely weaker policy is possible only once per-kind policy lands
 * server-side (ADR 0086 D-03) with a matching activation path; until then this
 * surface does not pretend to offer one.
 */
export function chooseMechanism(
  webauthnAvailable: boolean,
): Mechanism | undefined {
  return webauthnAvailable ? PASSKEY : undefined;
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
