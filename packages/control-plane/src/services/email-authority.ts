import type { AppContext } from "../context.js";
import type { TrustResolution } from "../interactions/trust.js";
import { organizationAssertedEmailIsVerified } from "./org-email-trust.js";

/**
 * Whether an upstream's `email_verified` claim may act as an account-JOIN key
 * (ADR 0057 D15) — not merely whether the upstream said so.
 *
 * The verified-email auto-link attaches a new identity to the principal that
 * already owns an address. That is a powerful thing to hand an issuer: it
 * means whoever controls the issuer decides who signs in as whom. The tuple
 * `(kind, issuer, subject)` is safe to take from any trusted issuer, because
 * it is scoped to that issuer and can only ever name that issuer's own
 * accounts. An email address is not — it is a global name, and an issuer
 * asserting one is making a claim about a namespace it may have no authority
 * over at all.
 *
 * Passing the trust fence is therefore NOT sufficient. `resolveTrustedIssuer`
 * answers "may we federate to this issuer?", and a visitor who typed their own
 * issuer into the bring-your-own form passes it by design — that is the whole
 * feature. Letting the same record's `email_verified: true` reach the join
 * would let anyone who can stand up an OIDC server sign in as any existing
 * user: register the issuer, mint an id_token claiming the victim's address is
 * verified, and be handed the victim's principal. Nothing about that requires
 * the victim to do anything.
 *
 * So authority is decided per trust source, and each answer is the narrowest
 * one that still makes the feature work:
 *
 * - **static registry** — only when the operator marked the provider
 *   authoritative. Google, Microsoft, Apple and GitHub ship that way because
 *   they verify ownership before claiming it; anything else an operator adds
 *   is off until they say otherwise.
 * - **bring-your-own** — never. The record was created by an unauthenticated
 *   visitor naming a server they control. It may mint them a *new* principal
 *   and nothing else.
 * - **organization** — only for a domain the organization proved it controls
 *   via DNS-TXT, which is the rule the SAML and directory legs already use.
 *   An owner may speak for `@theircompany.example` because they demonstrated
 *   they run it; they may not speak for `@gmail.com`.
 *
 * Callers that get `false` must drop the verification claim, not merely skip
 * the lookup: storing an unhonoured `emailVerified: true` would leave a row
 * that a later, genuinely verified sign-in would attach itself to, which is
 * the same takeover with the steps reversed.
 */
export async function emailClaimMayJoinAccounts(
  ctx: AppContext,
  trust: TrustResolution,
  emailNormalized: string | undefined,
): Promise<boolean> {
  if (!emailNormalized) return false;
  if (trust.source === "static") {
    return trust.provider.emailAuthoritative === true;
  }
  if (trust.source === "byo") return false;
  return organizationAssertedEmailIsVerified(
    ctx,
    trust.organizationId,
    emailNormalized,
  );
}

/**
 * The email half of an {@link import("./identity-link.js").AttachIdentityInput}.
 *
 * Named rather than written inline because it is a contract between the legs
 * and the admission chokepoint: `emailVerified` here means "this caller has
 * established the issuer may join accounts with this address", not "the
 * upstream said so".
 */
export type EmailLinkFields = {
  emailNormalized?: string;
  emailVerified?: boolean;
};

/**
 * The `{ emailNormalized?, emailVerified? }` half of an
 * {@link import("./identity-link.js").AttachIdentityInput}, decided by the
 * rule above.
 *
 * The address is recorded either way — it is worth having for support, and it
 * is what the denied-collision audit event reports on — but `emailVerified` is
 * set only when the issuer had the standing to say so.
 */
export async function emailLinkFields(
  ctx: AppContext,
  trust: TrustResolution,
  email: string | undefined,
  claimedVerified: boolean | undefined,
): Promise<EmailLinkFields> {
  const emailNormalized = email?.trim().toLowerCase() || undefined;
  if (emailNormalized === undefined) return {};
  const verified =
    claimedVerified === true &&
    (await emailClaimMayJoinAccounts(ctx, trust, emailNormalized));
  return verified
    ? { emailNormalized, emailVerified: true }
    : { emailNormalized };
}
