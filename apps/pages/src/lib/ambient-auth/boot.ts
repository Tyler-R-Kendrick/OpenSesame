/**
 * Pages startup: callback classification happens in App.tsx before this
 * runs. Default personal mode performs no network I/O. React runs it once
 * through `useAmbientAuthBoot` (bindings/ambient-auth.ts).
 */

import { readFederationSessionJson } from "../federation-session-store.js";
import {
  clearSession,
  discover,
  loadSession,
  redirectUri,
} from "../federation.js";
import { readLastSignIn } from "../last-sign-in.js";
import { signInMethods } from "../settings.js";
import { vaultStore } from "../vault/store.js";
import {
  ambientControllerSeams,
  evaluateEligibility,
  startAutomaticAttempt,
} from "./controller.js";
import { readUserAmbientPreference } from "./policy.js";
import { restoreAuthenticatedSession } from "./restoration.js";
import { deployedAmbientPolicy, deployedAmbientProviders } from "./runtime.js";

function revalidateStoredSession(): ReturnType<typeof loadSession> {
  const session = loadSession();
  if (!session) return null;
  void restoreAuthenticatedSession(
    readFederationSessionJson(),
    {
      issuer: session.issuer,
      clientId: session.audience,
      jwksUri: session.jwksUri,
    },
    fetch,
  ).then((result) => {
    // JWKS/network failure is `remembered` or `invalid`, not a signed
    // principal — loadSession already bound exp/sub/iss from the JWT.
    // Clearing those would make offline vault access depend on JWKS.
    if (
      result.kind === "rejected" &&
      (result.reason === "suppressed" ||
        result.reason === "untrusted" ||
        result.reason === "expired")
    ) {
      clearSession();
    }
  });
  return session;
}

/** Revalidate a stored session and, when eligible, start ambient sign-in. */
export function bootAmbientAuth(
  hasAuthCallback: boolean,
  pathname: string,
): void {
  const snapshot = vaultStore.getSnapshot();
  const session = revalidateStoredSession();
  const eligibility = evaluateEligibility({
    hasAuthCallback,
    pathname,
    vaultStatus:
      snapshot.status === "unlocked" || snapshot.status === "locked"
        ? snapshot.status
        : "empty",
    guestOpen: snapshot.guest === true && snapshot.status === "unlocked",
    privilegedOperation: snapshot.awaitingSecondStep === true,
    unsavedWork: false,
    localConsentRoute:
      pathname.startsWith("/identity/authorize") ||
      pathname.startsWith("/identity/siop"),
    existingVerifiedSession: session !== null,
    operatorProviders: [
      ...signInMethods().providers,
      ...deployedAmbientProviders(),
    ],
    runtimePolicy: deployedAmbientPolicy(),
    userPreference: readUserAmbientPreference(),
    lastSignInMethod: readLastSignIn(),
    openPairwiseSub: session?.pairwiseSub,
  });
  if (eligibility.state !== "eligible") return;
  ambientControllerSeams.discover = async (issuer) => {
    const doc = await discover(issuer);
    return {
      authorization_endpoint: doc.authorization_endpoint,
      token_endpoint: doc.token_endpoint,
      jwks_uri: doc.jwks_uri,
    };
  };
  void startAutomaticAttempt(eligibility, redirectUri());
}
