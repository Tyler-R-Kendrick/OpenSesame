/**
 * Build-time opt-in for the fresh-vault Passwords offer. Default off.
 *
 * Set `VITE_PWA_OFFER_PASSWORDS_ONBOARDING` to `1` or `true` (see
 * `.env.schema`). The onboarding chunk is omitted unless the dynamic import
 * in `passwords-onboarding-offer.tsx` is gated on this same env read: Vite
 * folds that condition and drops the module. Calling only this helper does
 * not.
 */
export function pwaOfferPasswordsOnboarding(): boolean {
  const stamped = import.meta.env.VITE_PWA_OFFER_PASSWORDS_ONBOARDING;
  return stamped === "1" || stamped === "true";
}
