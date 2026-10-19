import { Suspense, lazy } from "react";
import { pwaOfferPasswordsOnboarding } from "../../lib/pwa-offer-passwords-onboarding.js";

/**
 * Where the fresh-vault Passwords offer is drawn: the path strip, beside
 * New item, or the phone Add menu. Never the empty buffer.
 */
export type PasswordsOnboardingPlacement = "path" | "add-menu";

/**
 * Loaded only when `VITE_PWA_OFFER_PASSWORDS_ONBOARDING` is `1` or `true`.
 *
 * The condition is the env read itself, not `pwaOfferPasswordsOnboarding()`.
 * Vite replaces `import.meta.env` at build time and drops this `import()`
 * when the flag is off, so the onboarding module is absent from a default
 * production bundle. A helper call is not a constant Vite can fold.
 */
const PasswordsOnboarding =
  import.meta.env.VITE_PWA_OFFER_PASSWORDS_ONBOARDING === "1" ||
  import.meta.env.VITE_PWA_OFFER_PASSWORDS_ONBOARDING === "true"
    ? lazy(() =>
        import("./PasswordsOnboarding.js").then((module) => ({
          default: module.PasswordsOnboarding,
        })),
      )
    : null;

export function PasswordsOnboardingOffer({
  placement,
}: {
  placement: PasswordsOnboardingPlacement;
}) {
  if (!pwaOfferPasswordsOnboarding() || PasswordsOnboarding === null) {
    return null;
  }
  const Offer = PasswordsOnboarding;
  return (
    <Suspense fallback={null}>
      <Offer placement={placement} />
    </Suspense>
  );
}
