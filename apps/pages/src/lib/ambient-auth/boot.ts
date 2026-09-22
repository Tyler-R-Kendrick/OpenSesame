/**
 * Pages startup: callback classification happens in App.tsx before this
 * hook runs. Default personal mode performs no network I/O.
 */

import { useEffect, useRef } from "react";
import { restoreAuthenticatedSession } from "../federation-restoration.js";
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

export type AmbientBootInput = Readonly<{
  hasAuthCallback: boolean;
  pathname: string;
}>;

/**
 * One boot evaluation: revalidate a stored session, decide eligibility, and
 * start the automatic attempt when everything lines up. Run from
 * `identity.ambient-sso`'s `activate` (as a background job) — never at
 * module load, and never before that capability is approved.
 */
export function runAmbientAuthBoot({
  hasAuthCallback,
  pathname,
}: AmbientBootInput): void {
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

/** Legacy hook form; the module's background job calls `runAmbientAuthBoot`. */
export function useAmbientAuthBoot(
  hasAuthCallback: boolean,
  pathname: string,
): void {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    runAmbientAuthBoot({ hasAuthCallback, pathname });
  }, [hasAuthCallback, pathname]);
}
