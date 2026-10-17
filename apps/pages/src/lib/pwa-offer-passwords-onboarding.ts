/** Build-time opt-in for the fresh-vault Passwords offer. Default off. */
export function pwaOfferPasswordsOnboarding(): boolean {
  const stamped = import.meta.env.VITE_PWA_OFFER_PASSWORDS_ONBOARDING;
  return stamped === "1" || stamped === "true";
}
